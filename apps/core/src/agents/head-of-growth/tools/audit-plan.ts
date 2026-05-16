import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { mcpServerName } from "@shipflare/shared";
import type { HeadOfGrowth } from "../HeadOfGrowth";
import {
  extractTrace,
  withSubAgentToolTracing,
} from "../../../lib/subagent-activity";

/**
 * audit_plan — review the current plan_items list for gaps, redundancies, risks.
 *
 * Called by the CMO via `delegateToEmployee` when:
 *  - Founder asks "is our plan complete?" / "are there gaps?"
 *  - Periodic strategy review (CMO can schedule this)
 *  - After a strategic_path version commit
 *
 * Behavior:
 *  1. Read plan_items from CMO via RPC (optional status filter).
 *  2. Read founder_context from CMO via RPC for product-aware audit.
 *  3. Anthropic call to identify findings — high/med/low severity.
 *  4. Persist each finding to audit_findings (per spec §6.1: HoG private state).
 *  5. Return { findingsCount, findings: [...] } for caller.
 *
 * Per spec §6.1 invariant #1: HoG never writes the CMO's plan_items table
 * directly. Audit findings live in HoG's own SQLite; the CMO/founder reads
 * a summarized version through the tool's return value, not by querying
 * audit_findings cross-DO.
 */
export function registerAuditTool(agent: HeadOfGrowth): void {
  agent.server.registerTool(
    "audit_plan",
    {
      description:
        "Audit the current plan_items list. Reads from CMO via RPC, calls LLM " +
        "to identify gaps/redundancies/risks, persists to audit_findings. " +
        "Returns { findingsCount, findings: [{severity, finding, suggestedFix}] }.",
      inputSchema: {
        conversationId: z
          .string()
          .min(1)
          .describe("Founder conversation id for scoping findings"),
        statusFilter: z
          .enum(["pending", "in_progress", "completed", "failed", "cancelled"])
          .optional()
          .describe(
            "Optional: only audit plan_items in this status. Default: all",
          ),
        _trace: z.unknown().optional(),
      },
    },
    async (args) => {
      const trace = extractTrace(args);
      const { conversationId, statusFilter } = args as {
        conversationId: string;
        statusFilter?:
          | "pending"
          | "in_progress"
          | "completed"
          | "failed"
          | "cancelled";
      };
      return withSubAgentToolTracing(
        agent.runtimeCtx,
        agent.bindings,
        trace,
        "head-of-growth",
        "audit_plan",
        args,
        async () => {
          const userId = agent.props?.userId;
          if (!userId) {
            throw new Error("HoG has no userId in props; cannot audit");
          }

          // Step 1: pull plan_items from CMO via RPC
          const cmoServerName = mcpServerName("cmo", userId);
          const cmo = agent.mcp
            .listServers()
            .find((s) => s.name === cmoServerName);

          let planItems: Array<Record<string, unknown>> = [];
          if (cmo) {
            try {
              const result = await agent.mcp.callTool({
                serverId: cmo.id,
                name: "queryPlanItems",
                arguments: {
                  status: statusFilter,
                  limit: 200,
                },
              });
              const text = extractText(result);
              planItems = JSON.parse(text) as Array<Record<string, unknown>>;
            } catch (err) {
              console.warn(`[HoG ${userId}] queryPlanItems failed:`, err);
              // continue with empty list — the LLM will note an empty plan
            }
          } else {
            console.warn(
              `[HoG ${userId}] CMO not connected; auditing empty plan`,
            );
          }

          // Step 2: pull founder_context for product-aware audit
          let founderContext: Record<string, string> = {};
          if (cmo) {
            try {
              const result = await agent.mcp.callTool({
                serverId: cmo.id,
                name: "queryFounderContext",
                arguments: {},
              });
              founderContext = JSON.parse(extractText(result)) as Record<
                string,
                string
              >;
            } catch {
              // non-fatal — audit still runs without context
            }
          }

          // Step 3: Anthropic call
          const client = new Anthropic({
            apiKey: agent.bindings.ANTHROPIC_API_KEY,
          });
          const response = await client.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 2048,
            system: buildSystemPrompt(founderContext),
            messages: [
              {
                role: "user",
                content: `Audit the following plan items. Find gaps, redundancies, risks.\n\nPlan items:\n${JSON.stringify(planItems, null, 2)}`,
              },
            ],
          });

          const replyText = response.content
            .filter((c): c is Anthropic.TextBlock => c.type === "text")
            .map((c) => c.text)
            .join("\n");

          // Step 4: parse + persist findings
          const findings = parseFindings(replyText);
          for (const f of findings) {
            agent.sqlStorage.exec(
              `INSERT INTO audit_findings
             (conversation_id, target_id, severity, finding, suggested_fix, status)
           VALUES (?, ?, ?, ?, ?, 'open')`,
              conversationId,
              f.targetId ?? null,
              f.severity,
              f.finding,
              f.suggestedFix ?? null,
            );
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  findingsCount: findings.length,
                  findings,
                }),
              },
            ],
          };
        },
      );
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
 * Build the HoG auditor system prompt. Product-aware when founder_context
 * is populated; otherwise stays honest about not knowing the product.
 */
function buildSystemPrompt(ctx: Record<string, string>): string {
  const product = ctx.productName ?? "(product name not yet set)";
  const description = ctx.productDescription ?? "(description not yet set)";

  return `You are the Head of Growth auditing ${product}'s marketing plan.

Context:
- Product: ${product}
- Description: ${description}

Your job: review the plan_items provided by the user and identify gaps,
redundancies, or risks. Be specific and actionable.

Output ONLY a JSON array inside a \`\`\`json code block. No prose outside.

Schema:
\`\`\`json
[
  {
    "severity": "high",
    "finding": "<what's wrong / missing — be specific>",
    "suggestedFix": "<concrete fix — what to add/change>",
    "targetId": "<plan_item id this applies to, if any>"
  }
]
\`\`\`

severity ∈ {"high", "med", "low"}.
- "high": blocking — strategy can't succeed without fixing this
- "med": noticeable risk or gap — should fix before launch
- "low": minor — polish

If the plan is empty or near-empty, output a single high-severity finding
explaining what's missing. If the plan looks solid, output an empty array
[]. Never fabricate problems just to find something.`.trim();
}

/**
 * Parse the LLM output. Look for a fenced JSON block; fall back to a raw
 * JSON array if the model didn't wrap it. Returns [] on parse failure —
 * the empty list flows back to the caller as "no findings" rather than
 * surfacing a tool error to the founder.
 */
function parseFindings(text: string): Array<{
  severity: "high" | "med" | "low";
  finding: string;
  suggestedFix?: string;
  targetId?: string;
}> {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1] ?? text.match(/\[[\s\S]*\]/)?.[0];

  if (!candidate) return [];

  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (f): f is Record<string, unknown> =>
          typeof f === "object" && f !== null,
      )
      .map((f) => ({
        severity: (["high", "med", "low"].includes(f.severity as string)
          ? f.severity
          : "low") as "high" | "med" | "low",
        finding: typeof f.finding === "string" ? f.finding : "(no description)",
        suggestedFix:
          typeof f.suggestedFix === "string" ? f.suggestedFix : undefined,
        targetId: typeof f.targetId === "string" ? f.targetId : undefined,
      }));
  } catch {
    return [];
  }
}
