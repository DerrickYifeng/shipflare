import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { mcpServerName } from "@shipflare/shared";
import { extractText } from "../lib/mcp-result";
import type { CommunityManager } from "../CommunityManager";

/**
 * analyzeCommunityPulse — report sentiment + emerging topics from recent
 * community activity.
 *
 * Phase 2 P2-B SCOPE NOTE: real cross-DO reads of SMM's threads_inbox /
 * posted history depend on SMM exposing a list-style RPC tool (S4 ships
 * `find_threads` + `queryDrafts` but no "recent activity" projection).
 * Until that lands in Phase 2.x, this tool calls Anthropic with the
 * founder_context only and labels its output as a hypothesis. The schema
 * + tool surface stay stable across the upgrade — Phase 2.x replaces the
 * LLM prompt body, nothing else.
 *
 * Persists one row per finding to `community_findings(kind='pulse')`.
 */
export function registerAnalyzeCommunityPulseTool(
  agent: CommunityManager,
): void {
  agent.server.registerTool(
    "analyzeCommunityPulse",
    {
      description:
        "Read recent community activity (Phase 2 P2-B: founder_context " +
        "only; cross-DO reads of SMM history arrive in 2.x) and report " +
        "sentiment + emerging topics. Returns { sentiment, topics, sample }.",
      inputSchema: {
        platform: z
          .enum(["x", "reddit"])
          .optional()
          .describe("Optional platform to scope the pulse to."),
        window: z
          .string()
          .default("7d")
          .describe(
            "Time window descriptor (free text — Phase 2 P2-B uses the " +
              "LLM's hypothetical reasoning rather than a real DB filter).",
          ),
      },
    },
    async ({ platform, window }) => {
      const userId = agent.props?.userId;
      if (!userId) {
        throw new Error(
          "CommunityManager has no userId in props; cannot analyzeCommunityPulse",
        );
      }

      // Pull founder_context — product name, audience, voice — so the
      // hypothetical pulse stays anchored to the right audience.
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

      const client = new Anthropic({
        apiKey: agent.bindings.ANTHROPIC_API_KEY,
      });
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: `You are the Community Manager for ${ctx.productName ?? "the product"}.
Audience: ${ctx.audience ?? "(not yet defined)"}
Description: ${ctx.productDescription ?? "(not set)"}

You DON'T have direct access to recent threads in this Phase 2 P2-B
iteration — work from general knowledge of the audience + product to
hypothesize what the community pulse is likely showing in the last
${window} on ${platformLabel}. Be explicit that this is a hypothesis,
not measured data.

Output ONLY a JSON object inside a \`\`\`json code block. No prose outside.

Schema:
\`\`\`json
{
  "sentiment": "positive | mixed | negative | unknown",
  "topics": ["<emerging topic 1>", "<topic 2>"],
  "sample": "<2-3 sentence summary of the pulse as a hypothesis>"
}
\`\`\`

Rules:
- If you genuinely don't have enough context, set sentiment "unknown" and
  say so in sample.`,
        messages: [
          {
            role: "user",
            content: `Report the community pulse for ${platformLabel} over the last ${window}.`,
          },
        ],
      });

      const replyText = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      const parsed = parsePulse(replyText);

      agent.sqlStorage.exec(
        `INSERT INTO community_findings
           (platform, kind, finding, json, observed_at)
         VALUES (?, 'pulse', ?, ?, ?)`,
        platformLabel,
        parsed.sample,
        JSON.stringify({
          sentiment: parsed.sentiment,
          topics: parsed.topics,
          window,
        }),
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

interface PulseResult {
  sentiment: "positive" | "mixed" | "negative" | "unknown";
  topics: string[];
  sample: string;
}

function parsePulse(text: string): PulseResult {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as {
        sentiment?: string;
        topics?: unknown;
        sample?: string;
      };
      const sentiment = (
        ["positive", "mixed", "negative", "unknown"].includes(
          parsed.sentiment as string,
        )
          ? parsed.sentiment
          : "unknown"
      ) as PulseResult["sentiment"];
      return {
        sentiment,
        topics: Array.isArray(parsed.topics)
          ? parsed.topics.filter((t): t is string => typeof t === "string")
          : [],
        sample:
          typeof parsed.sample === "string"
            ? parsed.sample
            : "(no sample produced)",
      };
    } catch {
      // fall through
    }
  }
  return {
    sentiment: "unknown",
    topics: [],
    sample: text.slice(0, 500) || "(LLM did not produce structured output)",
  };
}
