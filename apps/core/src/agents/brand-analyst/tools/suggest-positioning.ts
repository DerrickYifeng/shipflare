import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { mcpServerName } from "@shipflare/shared";
import { extractText } from "../lib/mcp-result";
import type { BrandAnalyst } from "../BrandAnalyst";

/**
 * suggestPositioning — read recent competitor_analyses and propose a
 * positioning thesis for the founder's product.
 *
 * Phase 2 P2-B: pulls the last 20 competitor analyses from local SQLite +
 * founder_context from CMO, asks LLM for a thesis with evidence + confidence,
 * persists to positioning_suggestions. Phase 2.x will let the founder
 * promote an approved thesis to CMO.commitStrategicPath.
 */
export function registerSuggestPositioningTool(agent: BrandAnalyst): void {
  agent.server.registerTool(
    "suggestPositioning",
    {
      description:
        "Propose a positioning thesis for the founder's product, grounded " +
        "in recent competitor analyses + founder_context. Returns " +
        "{ id, thesis, evidence, confidence }.",
      inputSchema: {
        goal: z
          .string()
          .optional()
          .describe(
            "Optional founder goal to anchor the thesis (e.g. 'expand to enterprise').",
          ),
      },
    },
    async ({ goal }) => {
      const userId = agent.props?.userId;
      if (!userId) {
        throw new Error(
          "BrandAnalyst has no userId in props; cannot suggestPositioning",
        );
      }

      // Pull founder_context for product-aware suggestions.
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
            `[BrandAnalyst ${userId}] queryFounderContext failed:`,
            err,
          );
        }
      }

      // Pull recent competitor analyses (last 20, freshest first).
      const analyses = agent.sqlStorage
        .exec<{
          competitor: string;
          voice: string | null;
          themes_json: string | null;
          channels_json: string | null;
        }>(
          `SELECT competitor, voice, themes_json, channels_json
           FROM competitor_analyses
           ORDER BY analyzed_at DESC
           LIMIT 20`,
        )
        .toArray();

      const client = new Anthropic({
        apiKey: agent.bindings.ANTHROPIC_API_KEY,
      });
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1536,
        system: `You are the Brand Analyst for ${ctx.productName ?? "the product"}.
Product: ${ctx.productName ?? "(not set)"}
Description: ${ctx.productDescription ?? "(not set)"}
Audience: ${ctx.audience ?? "(not set)"}

Given recent competitor analyses + the founder's goal, propose a
positioning thesis. Be specific about where the product sits relative to
named competitors. Confidence ∈ [0, 1].

Output ONLY a JSON object inside a \`\`\`json code block. No prose outside.

Schema:
\`\`\`json
{
  "thesis": "<one-sentence positioning thesis>",
  "evidence": [
    "<concrete observation from a competitor analysis>",
    "<observation 2>"
  ],
  "confidence": 0.0
}
\`\`\`

Rules:
- thesis ≤ 200 chars. Lead with the differentiation, not the category.
- evidence cites specific competitors when possible.
- If you don't have enough analyses, return confidence ≤ 0.3 and say so
  in the thesis ("Insufficient data — ran with N competitors only").`,
        messages: [
          {
            role: "user",
            content: `Goal: ${goal ?? "(not specified)"}

Competitor analyses:
${JSON.stringify(analyses, null, 2)}`,
          },
        ],
      });

      const replyText = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      const parsed = parseSuggestion(replyText);
      const id = crypto.randomUUID();
      agent.sqlStorage.exec(
        `INSERT INTO positioning_suggestions
           (id, thesis, evidence_json, confidence, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        id,
        parsed.thesis,
        JSON.stringify(parsed.evidence),
        parsed.confidence,
        Date.now(),
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id,
              thesis: parsed.thesis,
              evidence: parsed.evidence,
              confidence: parsed.confidence,
            }),
          },
        ],
      };
    },
  );
}

function parseSuggestion(text: string): {
  thesis: string;
  evidence: string[];
  confidence: number;
} {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as {
        thesis?: string;
        evidence?: unknown;
        confidence?: number;
      };
      return {
        thesis:
          typeof parsed.thesis === "string"
            ? parsed.thesis
            : "(no thesis produced)",
        evidence: Array.isArray(parsed.evidence)
          ? parsed.evidence.filter((e): e is string => typeof e === "string")
          : [],
        confidence:
          typeof parsed.confidence === "number" &&
          parsed.confidence >= 0 &&
          parsed.confidence <= 1
            ? parsed.confidence
            : 0,
      };
    } catch {
      // fall through
    }
  }
  return {
    thesis:
      text.slice(0, 200) || "(LLM did not produce structured output)",
    evidence: [],
    confidence: 0,
  };
}
