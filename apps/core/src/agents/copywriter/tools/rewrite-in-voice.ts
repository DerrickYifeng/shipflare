import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { mcpServerName } from "@shipflare/shared";
import { extractText } from "../lib/mcp-result";
import type { Copywriter } from "../Copywriter";

/**
 * rewriteInVoice — take an existing draft and rewrite it in the founder's
 * voice (or a target voice override).
 *
 * Phase 2 P2-B keeps the implementation shallow: pull founder context for
 * voice, single Anthropic call, persist to copy_drafts(kind='rewrite').
 * Voice-lesson feedback loop arrives in Phase 2.x — for now the LLM
 * relies on the founder_context.voice string + the system prompt.
 */
export function registerRewriteInVoiceTool(agent: Copywriter): void {
  agent.server.registerTool(
    "rewriteInVoice",
    {
      description:
        "Rewrite a draft in the founder's voice. Returns a single revised " +
        "body plus a one-line rationale (`whyItWorks`). Persists the " +
        "rewrite to copy_drafts.",
      inputSchema: {
        body: z
          .string()
          .min(1)
          .describe("The draft to rewrite — any length, any platform."),
        targetVoice: z
          .string()
          .optional()
          .describe(
            "Optional override for the voice tag (defaults to founder_context.voice).",
          ),
      },
    },
    async ({ body, targetVoice }) => {
      const userId = agent.props?.userId;
      if (!userId) {
        throw new Error(
          "Copywriter has no userId in props; cannot rewriteInVoice",
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

      const voice =
        targetVoice ?? ctx.voice ?? "casual, no marketing fluff";

      const client = new Anthropic({
        apiKey: agent.bindings.ANTHROPIC_API_KEY,
      });
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: `You are the Copywriter. Rewrite the user's draft in this voice:
${voice}

Output ONLY a JSON object inside a \`\`\`json code block. No prose outside.

Schema:
\`\`\`json
{
  "body": "<rewritten draft — same intent, new voice>",
  "whyItWorks": "<one short sentence on why the rewrite lands>"
}
\`\`\`

Rules:
- Preserve facts and meaning; change only voice, rhythm, and word choice.
- No buzzwords. No "game-changer", "unlock", "revolutionize", "seamless".
- Match the length of the original within ±20%.`,
        messages: [{ role: "user", content: body }],
      });

      const replyText = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      const parsed = parseRewrite(replyText, body);

      const id = crypto.randomUUID();
      agent.sqlStorage.exec(
        `INSERT INTO copy_drafts (id, kind, brief, output, voice, created_at)
         VALUES (?, 'rewrite', ?, ?, ?, ?)`,
        id,
        body,
        parsed.body,
        voice,
        Date.now(),
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id,
              body: parsed.body,
              whyItWorks: parsed.whyItWorks,
            }),
          },
        ],
      };
    },
  );
}

/**
 * Parse the LLM rewrite output. Falls back to the raw text on parse
 * failure so the founder still sees something usable.
 */
function parseRewrite(
  text: string,
  original: string,
): { body: string; whyItWorks: string } {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as {
        body?: string;
        whyItWorks?: string;
      };
      if (typeof parsed.body === "string" && parsed.body.length > 0) {
        return {
          body: parsed.body,
          whyItWorks:
            typeof parsed.whyItWorks === "string"
              ? parsed.whyItWorks
              : "(no rationale)",
        };
      }
    } catch {
      // fall through
    }
  }
  // LLM didn't return JSON — surface its raw reply as the rewrite so the
  // founder at least sees the attempt rather than the original.
  return {
    body: text.trim().length > 0 ? text.trim() : original,
    whyItWorks: "(LLM did not produce structured output)",
  };
}
