import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { mcpServerName } from "@shipflare/shared";
import { extractText } from "../lib/mcp-result";
import type { Copywriter } from "../Copywriter";

/**
 * draftHeadlines — generate N candidate headlines for a topic.
 *
 * Phase 2 P2-B: pull voice + product context from CMO, ask LLM for a
 * JSON array of headlines, persist each one to copy_drafts(kind='headline').
 * Founder reviews them in the Copywriter conversation UI before promoting
 * any to a live post.
 */
export function registerDraftHeadlinesTool(agent: Copywriter): void {
  agent.server.registerTool(
    "draftHeadlines",
    {
      description:
        "Generate N headline variants for a topic in the founder's voice. " +
        "Returns { headlines: string[] }. Each headline is persisted to " +
        "copy_drafts so it can be promoted later.",
      inputSchema: {
        topic: z
          .string()
          .min(1)
          .describe("Topic, product, or campaign to headline."),
        count: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe("Number of variants to generate (1-20, default 5)."),
      },
    },
    async ({ topic, count }) => {
      const userId = agent.props?.userId;
      if (!userId) {
        throw new Error(
          "Copywriter has no userId in props; cannot draftHeadlines",
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
            `[Copywriter ${userId}] queryFounderContext failed:`,
            err,
          );
        }
      }

      const voice = ctx.voice ?? "casual, no marketing fluff";
      const product = ctx.productName ?? "(product name not set)";
      const audience = ctx.audience ?? "(audience not yet defined)";

      const client = new Anthropic({
        apiKey: agent.bindings.ANTHROPIC_API_KEY,
      });
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: `You are the Copywriter for ${product}.
Audience: ${audience}
Voice: ${voice}

Generate ${count} headline variants for the topic the user gives you.

Output ONLY a JSON array of strings inside a \`\`\`json code block. No prose outside.

Schema:
\`\`\`json
[
  "<headline 1>",
  "<headline 2>"
]
\`\`\`

Rules:
- Vary structure (statement, question, list, contrast) across the set.
- No buzzwords ("game-changer", "unlock", "revolutionize", "seamless").
- ≤ 80 characters each — punchy beats clever.`,
        messages: [{ role: "user", content: `Topic: ${topic}` }],
      });

      const replyText = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      const headlines = parseHeadlines(replyText, count);

      // Persist each headline as its own row so the founder can promote
      // them individually downstream. One transaction would be nicer but
      // SQLite-backed DOs serialize sql.exec already; the cost is one
      // round-trip per headline (cheap).
      const ts = Date.now();
      for (const h of headlines) {
        agent.sqlStorage.exec(
          `INSERT INTO copy_drafts (id, kind, brief, output, voice, created_at)
           VALUES (?, 'headline', ?, ?, ?, ?)`,
          crypto.randomUUID(),
          topic,
          h,
          voice,
          ts,
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ headlines }),
          },
        ],
      };
    },
  );
}

function parseHeadlines(text: string, fallbackCount: number): string[] {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1] ?? text.match(/\[[\s\S]*\]/)?.[0];
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((h): h is string => typeof h === "string" && h.length > 0)
          .slice(0, fallbackCount);
      }
    } catch {
      // fall through
    }
  }
  // Fallback: line-split the raw text so the founder still sees attempts.
  return text
    .split("\n")
    .map((l) => l.replace(/^[-*\d.\s"']+|["']+$/g, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, fallbackCount);
}
