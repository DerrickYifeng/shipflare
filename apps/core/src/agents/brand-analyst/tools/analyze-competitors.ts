import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import type { BrandAnalyst } from "../BrandAnalyst";

/**
 * analyzeCompetitors — survey 1-10 competitors and capture voice / themes /
 * channels for each.
 *
 * Phase 2 P2-B: relies on the LLM's general knowledge — no live web search
 * yet. Phase 2.x will swap the Anthropic call for an xAI live-search or
 * Perplexity-backed pipeline so the output reflects current positioning,
 * not the model's training cutoff. The schema and tool surface are stable
 * across that upgrade; only the body of this function changes.
 *
 * Persists one row per competitor to `competitor_analyses`.
 */
export function registerAnalyzeCompetitorsTool(agent: BrandAnalyst): void {
  agent.server.registerTool(
    "analyzeCompetitors",
    {
      description:
        "Survey competitor positioning / messaging from general knowledge " +
        "(Phase 2 P2-B; live web search lands in 2.x). Returns " +
        "{ analyses: [{ competitor, voice, themes, channels }] } and " +
        "persists each row to competitor_analyses.",
      inputSchema: {
        competitors: z
          .array(z.string().min(1))
          .min(1)
          .max(10)
          .describe("Competitor names — 1 to 10."),
      },
    },
    async ({ competitors }) => {
      const userId = agent.props?.userId;
      if (!userId) {
        throw new Error(
          "BrandAnalyst has no userId in props; cannot analyzeCompetitors",
        );
      }

      const client = new Anthropic({
        apiKey: agent.bindings.ANTHROPIC_API_KEY,
      });
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: `You are the Brand Analyst. Survey the competitors the user names and
report each one's positioning. Be concrete; if you don't know a competitor,
say so in voice/themes rather than inventing.

Output ONLY a JSON array inside a \`\`\`json code block. No prose outside.

Schema:
\`\`\`json
[
  {
    "competitor": "<name>",
    "voice": "<one-line impression of their brand voice>",
    "themes": ["<recurring theme 1>", "<theme 2>"],
    "channels": ["x", "linkedin", "youtube"]
  }
]
\`\`\`

Rules:
- One entry per competitor — preserve input order.
- channels ⊂ {"x", "reddit", "linkedin", "youtube", "tiktok", "blog", "podcast", "newsletter"}.
- If you genuinely don't have signal on a competitor, set voice to
  "(insufficient signal)" and leave themes/channels empty rather than
  guessing.`,
        messages: [
          {
            role: "user",
            content: `Competitors:\n${competitors.map((c) => `- ${c}`).join("\n")}`,
          },
        ],
      });

      const replyText = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      const analyses = parseAnalyses(replyText);
      const ts = Date.now();
      for (const a of analyses) {
        agent.sqlStorage.exec(
          `INSERT INTO competitor_analyses
             (id, competitor, voice, themes_json, channels_json, analyzed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          crypto.randomUUID(),
          a.competitor,
          a.voice,
          JSON.stringify(a.themes),
          JSON.stringify(a.channels),
          ts,
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ analyses }),
          },
        ],
      };
    },
  );
}

interface CompetitorAnalysis {
  competitor: string;
  voice: string;
  themes: string[];
  channels: string[];
}

function parseAnalyses(text: string): CompetitorAnalysis[] {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1] ?? text.match(/\[[\s\S]*\]/)?.[0];
  if (!candidate) return [];
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (a): a is Record<string, unknown> =>
          typeof a === "object" && a !== null,
      )
      .map((a) => ({
        competitor:
          typeof a.competitor === "string" ? a.competitor : "(unknown)",
        voice: typeof a.voice === "string" ? a.voice : "",
        themes: Array.isArray(a.themes)
          ? a.themes.filter((t): t is string => typeof t === "string")
          : [],
        channels: Array.isArray(a.channels)
          ? a.channels.filter((c): c is string => typeof c === "string")
          : [],
      }));
  } catch {
    return [];
  }
}
