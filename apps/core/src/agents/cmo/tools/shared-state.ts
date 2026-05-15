import { z } from "zod";
import { mcpServerName } from "@shipflare/shared";
import type { CMO } from "../CMO";

/**
 * Shared-state tools exposed by CMO for employees to call via RPC.
 *
 * Per spec §6.1 invariant #1: CMO SQLite is the per-team source of truth.
 * Other employees never write CMO SQLite directly — they call these tools.
 *
 * Tools:
 * - queryFounderContext / setFounderContext — identity-level KV
 * - commitStrategicPath — HoG records a new strategy version
 * - addPlanItem / queryPlanItems / updatePlanItem — plan tickets
 * - approveDraft / rejectDraft — founder approval/rejection, later wires to publish
 * - queryDrafts — RPCs to SMM.list_drafts (returns [] if SMM not connected)
 */
export function registerSharedStateTools(agent: CMO): void {
  agent.server.registerTool(
    "queryFounderContext",
    {
      description:
        "Read the founder_context KV map. Employees call this on connection.",
      inputSchema: {},
    },
    async () => {
      const rows = agent.sqlStorage
        .exec<{ key: string; value: string }>(
          "SELECT key, value FROM founder_context",
        )
        .toArray();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              Object.fromEntries(rows.map((r) => [r.key, r.value])),
            ),
          },
        ],
      };
    },
  );

  agent.server.registerTool(
    "setFounderContext",
    {
      description:
        "Upsert a single founder_context KV pair (e.g. productName, voice).",
      inputSchema: {
        key: z.string().min(1),
        value: z.string(),
      },
    },
    async ({ key, value }) => {
      agent.sqlStorage.exec(
        `INSERT INTO founder_context (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        key,
        value,
      );
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  );

  agent.server.registerTool(
    "commitStrategicPath",
    {
      description:
        "Record a new strategic_path version. Called by Head of Growth after generating a plan. " +
        "Auto-increments version. Status starts as 'pending_approval'.",
      inputSchema: {
        theme: z.string().min(1),
        narrative: z.record(z.string(), z.unknown()),
        generatedBy: z.string().min(1),
      },
    },
    async ({ theme, narrative, generatedBy }) => {
      const id = crypto.randomUUID();
      const latest = agent.sqlStorage
        .exec<{ v: number }>(
          "SELECT COALESCE(MAX(version), 0) as v FROM strategic_path",
        )
        .one();
      const version = latest.v + 1;
      agent.sqlStorage.exec(
        `INSERT INTO strategic_path
         (id, version, theme, narrative_json, status, generated_at, generated_by)
         VALUES (?, ?, ?, ?, 'pending_approval', ?, ?)`,
        id,
        version,
        theme,
        JSON.stringify(narrative),
        Date.now(),
        generatedBy,
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ id, version }) },
        ],
      };
    },
  );

  agent.server.registerTool(
    "addPlanItem",
    {
      description:
        "Create a plan_item ticket. HoG/SMM use this to enqueue work.",
      inputSchema: {
        skill: z.string().min(1),
        channel: z.enum(["x", "reddit"]),
        params: z.record(z.string(), z.unknown()),
        ownerRole: z.string().min(1),
        scheduledFor: z.number().optional(),
      },
    },
    async ({ skill, channel, params, ownerRole, scheduledFor }) => {
      const id = crypto.randomUUID();
      agent.sqlStorage.exec(
        `INSERT INTO plan_items
         (id, skill, channel, params_json, status, owner_role, scheduled_for)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        id,
        skill,
        channel,
        JSON.stringify(params),
        ownerRole,
        scheduledFor ?? null,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id }) }],
      };
    },
  );

  agent.server.registerTool(
    "queryPlanItems",
    {
      description:
        "List plan_items. Filterable by status + owner_role. SMM reads this to find work.",
      inputSchema: {
        status: z.string().optional(),
        ownerRole: z.string().optional(),
        limit: z.number().int().positive().max(200).default(50),
      },
    },
    async ({ status, ownerRole, limit }) => {
      // Build query — SQLite param binding doesn't support optional WHERE
      // clauses elegantly, so we branch.
      let q =
        "SELECT id, skill, channel, params_json, status, owner_role, scheduled_for, started_at, completed_at FROM plan_items WHERE 1=1";
      const bindings: unknown[] = [];
      if (status) {
        q += " AND status = ?";
        bindings.push(status);
      }
      if (ownerRole) {
        q += " AND owner_role = ?";
        bindings.push(ownerRole);
      }
      q +=
        " ORDER BY scheduled_for IS NULL, scheduled_for ASC, plan_version ASC LIMIT ?";
      bindings.push(limit);
      // SqlStorage.exec is a varargs function; spread the prepared bindings.
      const rows = agent.sqlStorage
        .exec(q, ...(bindings as SqlStorageValue[]))
        .toArray();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows) }],
      };
    },
  );

  agent.server.registerTool(
    "updatePlanItem",
    {
      description:
        "Update plan_item status + optional output payload. SMM reports completion via this.",
      inputSchema: {
        id: z.string().min(1),
        status: z.enum([
          "pending",
          "in_progress",
          "completed",
          "failed",
          "cancelled",
        ]),
        output: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ id, status, output }) => {
      const now = Date.now();
      const result = agent.sqlStorage.exec(
        `UPDATE plan_items SET
           status = ?,
           output_json = ?,
           started_at = COALESCE(started_at, CASE WHEN ? = 'in_progress' THEN ? END),
           completed_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN ? ELSE completed_at END
         WHERE id = ?`,
        status,
        output ? JSON.stringify(output) : null,
        status,
        now,
        status,
        now,
        id,
      );
      if (result.rowsWritten === 0) {
        throw new Error(`plan_item not found: ${id}`);
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ id, status }) },
        ],
      };
    },
  );

  agent.server.registerTool(
    "approveDraft",
    {
      description:
        "Founder approves a draft. Marks the approval_queue row decided='approved'.",
      inputSchema: {
        draftId: z.string().min(1),
      },
    },
    async ({ draftId }) => {
      const result = agent.sqlStorage.exec(
        `UPDATE approval_queue
         SET decided_at = ?, decision = 'approved'
         WHERE draft_id = ?`,
        Date.now(),
        draftId,
      );
      if (result.rowsWritten === 0) {
        throw new Error(`draft not in approval_queue: ${draftId}`);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ draftId, decision: "approved" }),
          },
        ],
      };
    },
  );

  agent.server.registerTool(
    "rejectDraft",
    {
      description:
        "Founder rejects a draft. Marks the approval_queue row decided='rejected'. " +
        "Optional reason is accepted for future use but not persisted until " +
        "approval_queue.reason column lands.",
      inputSchema: {
        draftId: z.string().min(1),
        // reason is parsed but not persisted until approval_queue.reason column lands
        reason: z.string().max(500).optional(),
      },
    },
    async ({ draftId }) => {
      const result = agent.sqlStorage.exec(
        `UPDATE approval_queue
         SET decided_at = ?, decision = 'rejected'
         WHERE draft_id = ?`,
        Date.now(),
        draftId,
      );
      if (result.rowsWritten === 0) {
        throw new Error(`draft not in approval_queue: ${draftId}`);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ draftId, decision: "rejected" }),
          },
        ],
      };
    },
  );

  // queryDrafts — RPCs to SMM.list_drafts (S4.5 partial). Returns "[]" if
  // SMM isn't connected (cron tick before hire, or SMM binding missing —
  // same forward-compat shape as CMO's cron handler).
  agent.server.registerTool(
    "queryDrafts",
    {
      description:
        "List drafts (typically pending approval) by status. RPCs to SMM. " +
        "Returns [] if SMM not connected.",
      inputSchema: {
        status: z
          .enum(["drafting", "ready", "posted", "failed", "rejected"])
          .default("ready"),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async ({ status, limit }) => {
      const userId = agent.props?.userId;
      if (!userId) {
        return { content: [{ type: "text" as const, text: "[]" }] };
      }
      const smmServerName = mcpServerName("social-media-manager", userId);
      const smm = agent.mcp
        .listServers()
        .find((s) => s.name === smmServerName);
      if (!smm) {
        return { content: [{ type: "text" as const, text: "[]" }] };
      }
      try {
        const result = await agent.mcp.callTool({
          serverId: smm.id,
          name: "list_drafts",
          arguments: { status, limit },
        });
        // Pass through the JSON string SMM returned. Single-pass extract
        // avoids the need to JSON.parse + re-stringify when SMM already
        // wrapped rows as { content: [{ type: 'text', text: '<json>' }] }.
        return {
          content: [{ type: "text" as const, text: extractText(result) }],
        };
      } catch (err) {
        console.warn(`[CMO ${userId}] list_drafts RPC failed:`, err);
        return { content: [{ type: "text" as const, text: "[]" }] };
      }
    },
  );

  // P2-D: Cross-conversation memory ("Remember this") — opt-in long-term
  // facts that get injected into every chat tool's system prompt regardless
  // of conversationId. Founder is the sole writer (no auto-record); the
  // chat UI surfaces a "Remember" button on assistant turns.
  agent.server.registerTool(
    "rememberThis",
    {
      description:
        "Save a fact / preference to long-term memory. Will be injected " +
        "into every future conversation's system prompt. Opt-in: founder " +
        "clicks 'Remember' on UI; not auto-recorded.",
      inputSchema: {
        content: z.string().min(1).max(2000),
        sourceConversationId: z.string().optional(),
        sourceMessageTs: z.number().int().optional(),
      },
    },
    async ({ content, sourceConversationId, sourceMessageTs }) => {
      const id = crypto.randomUUID();
      agent.sqlStorage.exec(
        `INSERT INTO cross_conversation_memory
           (id, content, source_conversation_id, source_message_ts, added_at, active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        id,
        content,
        sourceConversationId ?? null,
        sourceMessageTs ?? null,
        Date.now(),
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ id, ok: true }) },
        ],
      };
    },
  );

  agent.server.registerTool(
    "forgetThis",
    {
      description:
        "Deactivate a memory entry (soft delete; keeps audit trail).",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      const result = agent.sqlStorage.exec(
        "UPDATE cross_conversation_memory SET active = 0 WHERE id = ?",
        id,
      );
      if (result.rowsWritten === 0) {
        throw new Error(`memory not found: ${id}`);
      }
      return { content: [{ type: "text" as const, text: "forgotten" }] };
    },
  );

  agent.server.registerTool(
    "queryMemory",
    {
      description: "List active long-term memories, newest first.",
      inputSchema: {
        limit: z.number().int().positive().max(100).default(50),
      },
    },
    async ({ limit }) => {
      const rows = agent.sqlStorage
        .exec<{
          id: string;
          content: string;
          added_at: number;
          source_conversation_id: string | null;
        }>(
          `SELECT id, content, added_at, source_conversation_id
           FROM cross_conversation_memory
           WHERE active = 1
           ORDER BY added_at DESC
           LIMIT ?`,
          limit,
        )
        .toArray();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows) }],
      };
    },
  );
}

/**
 * Extract the text content from an MCP tool result. Tools return
 * `{ content: [{ type: "text", text: "..." }, ...] }`. This walks the
 * array and concatenates text blocks.
 *
 * Duplicated from `find-threads-via-xai.ts`; if a third caller needs it,
 * lift to `apps/core/src/agents/_shared/mcp-result.ts`.
 */
function extractText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  if (!r.content) return "";
  return r.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}
