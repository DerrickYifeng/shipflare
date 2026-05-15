import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { mcpServerName } from "@shipflare/shared";
import type { HeadOfGrowth } from "../HeadOfGrowth";

/**
 * generate_strategic_path — produce a marketing strategy for the founder.
 *
 * Called by the CMO via `delegateToEmployee` when the founder asks
 * something strategic ("what's our wedge?", "how should we approach Reddit?").
 *
 * Behavior:
 *  1. Pull founder_context from CMO via RPC (productName, voice, audience).
 *  2. Load HoG's prior planning_chat for this conversation (continuity).
 *  3. Anthropic call returns a structured plan: theme, narrative, rationale.
 *  4. Persist user goal + assistant reasoning to planning_chat.
 *  5. Persist the proposal to proposal_drafts (HoG working space).
 *  6. RPC back to CMO.commitStrategicPath to write the canonical version
 *     into per-team SoT.
 *  7. Return summary for the caller.
 *
 * Per spec §6.1 invariant #1: HoG never writes CMO's strategic_path table
 * directly. All shared state goes through CMO's exposed RPC tools.
 */
export function registerStrategicPathTool(agent: HeadOfGrowth): void {
  agent.server.registerTool(
    "generate_strategic_path",
    {
      description:
        "Generate a focused marketing strategy for the founder. Reads " +
        "founder_context for product details, calls LLM, writes the " +
        "canonical strategy to CMO's strategic_path table via RPC. " +
        "Returns { theme, summary, version, proposalId }.",
      inputSchema: {
        goal: z
          .string()
          .min(1)
          .describe("Founder's goal or question prompting the planning"),
        conversationId: z
          .string()
          .min(1)
          .describe("Current founder conversation id for scoping"),
      },
    },
    async ({ goal, conversationId }) => {
      const userId = agent.props?.userId;
      if (!userId) {
        throw new Error("HoG has no userId in props; cannot generate plan");
      }

      // Step 1: pull founder_context via CMO RPC
      const cmoServerName = mcpServerName("cmo", userId);
      const servers = agent.mcp.listServers();
      const cmo = servers.find((s) => s.name === cmoServerName);

      let founderContext: Record<string, string> = {};
      if (cmo) {
        try {
          const result = await agent.mcp.callTool({
            serverId: cmo.id,
            name: "queryFounderContext",
            arguments: {},
          });
          // result.content[0].text is JSON of {key:value}
          const text = extractText(result);
          founderContext = JSON.parse(text) as Record<string, string>;
        } catch (err) {
          console.warn(`[HoG ${userId}] queryFounderContext failed:`, err);
          // continue with empty context — the LLM will be honest about
          // not knowing product details
        }
      } else {
        console.warn(
          `[HoG ${userId}] CMO not connected; planning without context`,
        );
      }

      // Step 2: load prior planning_chat for this conversation
      const priorChat = agent.sqlStorage
        .exec<{ role: string; content: string }>(
          "SELECT role, content FROM planning_chat WHERE conversation_id = ? ORDER BY ts ASC",
          conversationId,
        )
        .toArray();

      // Step 3: Anthropic call
      const client = new Anthropic({ apiKey: agent.bindings.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: buildSystemPrompt(founderContext),
        messages: [
          // include prior planning conversation as context
          ...priorChat.map((m) => ({
            role: (m.role === "assistant" ? "assistant" : "user") as
              | "user"
              | "assistant",
            content: m.content,
          })),
          { role: "user" as const, content: goal },
        ],
      });

      const replyText = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      // Step 4: persist planning_chat (user goal + assistant reasoning)
      const ts = Date.now();
      agent.sqlStorage.exec(
        "INSERT INTO planning_chat (conversation_id, role, content, ts) VALUES (?, ?, ?, ?)",
        conversationId,
        "user",
        goal,
        ts,
      );
      agent.sqlStorage.exec(
        "INSERT INTO planning_chat (conversation_id, role, content, ts) VALUES (?, ?, ?, ?)",
        conversationId,
        "assistant",
        replyText,
        ts + 1,
      );

      // Step 5: extract structured plan from the LLM output (JSON in code block or raw)
      const parsed = parsePlan(replyText);

      // Step 6: write proposal_draft (HoG working space)
      const proposalId = crypto.randomUUID();
      agent.sqlStorage.exec(
        `INSERT INTO proposal_drafts
           (id, theme, narrative_md, status, alternatives_json, confidence, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        proposalId,
        parsed.theme,
        parsed.narrativeMd,
        JSON.stringify(parsed.alternatives ?? []),
        parsed.confidence,
        Date.now(),
      );

      // Step 7: commit canonical version to CMO via RPC
      let committedVersion: number | null = null;
      if (cmo) {
        try {
          const result = await agent.mcp.callTool({
            serverId: cmo.id,
            name: "commitStrategicPath",
            arguments: {
              theme: parsed.theme,
              narrative: parsed.narrative,
              generatedBy: "head-of-growth",
            },
          });
          const text = extractText(result);
          const parsedResult = JSON.parse(text) as {
            id: string;
            version: number;
          };
          committedVersion = parsedResult.version;
        } catch (err) {
          console.error(
            `[HoG ${userId}] commitStrategicPath failed:`,
            err,
          );
          // Proposal is in HoG's working space; CMO didn't get the canonical
          // version. Return the proposal anyway so the caller can retry the
          // commit via CMO's tool directly.
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              proposalId,
              theme: parsed.theme,
              summary: parsed.rationale,
              version: committedVersion,
              committed: committedVersion !== null,
            }),
          },
        ],
      };
    },
  );
}

/**
 * Extract the text content from an MCP tool result. Tools return
 * `{ content: [{ type: "text", text: "..." }, ...] }`. This walks the
 * array and concatenates text blocks.
 */
function extractText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  if (!r.content) return "";
  return r.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

/**
 * Build the HoG system prompt. Voice-and-context aware; if the founder
 * hasn't set product details yet, the LLM is honest about not knowing.
 */
function buildSystemPrompt(ctx: Record<string, string>): string {
  const product = ctx.productName ?? "(product name not yet set)";
  const description = ctx.productDescription ?? "(description not yet set)";
  const audience = ctx.audience ?? "(audience not yet defined)";
  const voice = ctx.voice ?? "default — tech founder, no marketing fluff";

  return `You are the Head of Growth for ${product}.

Context:
- Product: ${product}
- Description: ${description}
- Audience: ${audience}
- Voice: ${voice}

Your job is to generate a focused marketing strategy. Output ONLY a JSON
object inside a \`\`\`json code block. No prose outside the block.

Schema:
\`\`\`json
{
  "theme": "<one-line theme of the strategy>",
  "narrative": {
    "thesis": "<core thesis — why this approach>",
    "wedge": "<narrowest entry point>",
    "channels": ["x", "reddit"],
    "first_30_days": [
      "<concrete action 1>",
      "<concrete action 2>",
      "..."
    ]
  },
  "rationale": "<1-2 sentence summary suitable for the founder>",
  "confidence": 0.0,
  "alternatives": []
}
\`\`\`

Be concrete. No buzzwords. Numbers and specifics over vague promises. If you
don't have enough context (product undefined, etc.), say so in rationale.`.trim();
}

/**
 * Parse the LLM output. Look for a fenced JSON block; fall back to raw
 * JSON if the model didn't wrap it; final fallback yields a minimal valid
 * shape with the raw text in rationale.
 */
function parsePlan(text: string): {
  theme: string;
  narrative: Record<string, unknown>;
  narrativeMd: string;
  rationale: string;
  confidence: number;
  alternatives: unknown[];
} {
  const fencedMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidate = fencedMatch?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];

  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as {
        theme?: string;
        narrative?: Record<string, unknown>;
        rationale?: string;
        confidence?: number;
        alternatives?: unknown[];
      };
      return {
        theme: parsed.theme ?? "Untitled strategy",
        narrative: parsed.narrative ?? {},
        narrativeMd: JSON.stringify(parsed.narrative ?? {}, null, 2),
        rationale: parsed.rationale ?? "",
        confidence:
          typeof parsed.confidence === "number" ? parsed.confidence : 0,
        alternatives: parsed.alternatives ?? [],
      };
    } catch {
      // fall through to fallback
    }
  }

  // Fallback: LLM didn't produce parseable JSON. Keep the raw text in
  // rationale so the founder can read what the LLM was trying to say.
  return {
    theme: "Unstructured output (LLM didn't produce valid JSON)",
    narrative: {},
    narrativeMd: text,
    rationale: text.slice(0, 500),
    confidence: 0,
    alternatives: [],
  };
}
