import { z } from "zod";
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
 * - approveDraft — founder approval, later wires to publish
 * - queryDrafts — RPC to SMM for now is stubbed (SMM doesn't exist yet)
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

  // queryDrafts — placeholder until SMM (S4) exists. For now returns [].
  // Once SMM has listDrafts, this becomes an RPC into the SMM McpServer.
  agent.server.registerTool(
    "queryDrafts",
    {
      description:
        "List drafts (pending approval, etc.). Currently returns [] — wires to SMM in a later task.",
      inputSchema: {
        status: z.string().optional(),
      },
    },
    async () => {
      // TODO(S2.4-followup): once SMM lands in S4, RPC to
      // mcpServers[mcpServerName("social-media-manager", userId)].callTool(
      //   "listDrafts", {...}
      // )
      return {
        content: [{ type: "text" as const, text: "[]" }],
      };
    },
  );
}
