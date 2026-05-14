import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { mcpServerName } from "@shipflare/shared";
import { extractText } from "../lib/mcp-result";
import type { CommunityManager } from "../CommunityManager";

/**
 * summarizeMentions — produce a digest of recent mentions of the founder's
 * product on a given platform.
 *
 * Phase 2 P2-B SCOPE NOTE: same caveat as analyzeCommunityPulse — until
 * SMM exposes a list-style RPC for recent mention threads, the tool calls
 * Anthropic with founder_context only and labels the output as hypothesis.
 * Phase 2.x: wire to SMM.find_threads (existing RPC) with a `productName`
 * keyword filter and feed the results into the LLM prompt.
 *
 * Persists one row per call to `community_findings(kind='mention_summary')`.
 */
export function registerSummarizeMentionsTool(
  agent: CommunityManager,
): void {
  agent.server.registerTool(
    "summarizeMentions",
    {
      description:
        "Summarize recent mentions of the founder's product. Returns " +
        "{ summary, mentions: [{ where, gist }] }. Phase 2 P2-B uses " +
        "hypothesis-shaped output; live mention data arrives in 2.x.",
      inputSchema: {
        platform: z
          .enum(["x", "reddit"])
          .optional()
          .describe("Optional platform scope."),
      },
    },
    async ({ platform }) => {
      const userId = agent.props?.userId;
      if (!userId) {
        throw new Error(
          "CommunityManager has no userId in props; cannot summarizeMentions",
        );
      }

      const cmoServerName = mcpServerName("cmo", userId);
      const cmo = agent.mcp
        .listServers()
        .find((s) => s.name === cmoServerName);
      let ctx: Record<string, string> = {};
      if (cmo) {
        try {
          const result = await agent.mcp.callTool({
            serverId: cmo.id,
            name: "queryFounderContext",
            arguments: {},
          });
          ctx = JSON.parse(extractText(result)) as Record<string, string>;
        } catch (err) {
          console.warn(
            `[CommunityManager ${userId}] queryFounderContext failed:`,
            err,
          );
        }
      }

      const platformLabel = platform ?? "all platforms";
      const product = ctx.productName ?? "(product name not set)";

      const client = new Anthropic({
        apiKey: agent.bindings.ANTHROPIC_API_KEY,
      });
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: `You are the Community Manager for ${product}.
Audience: ${ctx.audience ?? "(not yet defined)"}

You DON'T have direct mention data in this Phase 2 P2-B iteration — work
from general knowledge of how products in the founder's space are usually
mentioned on ${platformLabel}, and explicitly label the output as a
hypothesis rather than measured data.

Output ONLY a JSON object inside a \`\`\`json code block. No prose outside.

Schema:
\`\`\`json
{
  "summary": "<2-3 sentence digest of likely mention patterns>",
  "mentions": [
    { "where": "<r/subreddit or @handle>", "gist": "<plausible mention shape>" }
  ]
}
\`\`\`

Rules:
- mentions ≤ 5. Keep entries short.
- If you genuinely lack signal, return summary "(insufficient context)"
  and mentions [].`,
        messages: [
          {
            role: "user",
            content: `Summarize recent mentions of ${product} on ${platformLabel}.`,
          },
        ],
      });

      const replyText = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      const parsed = parseMentions(replyText);

      agent.sqlStorage.exec(
        `INSERT INTO community_findings
           (platform, kind, finding, json, observed_at)
         VALUES (?, 'mention_summary', ?, ?, ?)`,
        platformLabel,
        parsed.summary,
        JSON.stringify({ mentions: parsed.mentions }),
        Date.now(),
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(parsed),
          },
        ],
      };
    },
  );
}

interface MentionsResult {
  summary: string;
  mentions: Array<{ where: string; gist: string }>;
}

function parseMentions(text: string): MentionsResult {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as {
        summary?: string;
        mentions?: unknown;
      };
      const summary =
        typeof parsed.summary === "string"
          ? parsed.summary
          : "(no summary produced)";
      const mentions = Array.isArray(parsed.mentions)
        ? parsed.mentions
            .filter(
              (m): m is Record<string, unknown> =>
                typeof m === "object" && m !== null,
            )
            .map((m) => ({
              where: typeof m.where === "string" ? m.where : "(unknown)",
              gist: typeof m.gist === "string" ? m.gist : "",
            }))
        : [];
      return { summary, mentions };
    } catch {
      // fall through
    }
  }
  return {
    summary:
      text.slice(0, 500) || "(LLM did not produce structured output)",
    mentions: [],
  };
}
