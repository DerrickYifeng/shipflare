import { z } from "zod";
import type { CMO } from "../CMO";

/**
 * `getRecentActivity` MCP tool — Task 5 of spec
 * 2026-05-15-agent-activity-feed-design.
 *
 * Reads the tail of the per-team `activity_events` table for a single
 * conversation or run. The web client calls this on mount + after WS
 * reconnect to seed the activity feed before the live stream takes
 * over. Pass `sinceMs` (the last-seen `createdAt`) on reconnect to
 * avoid re-fetching events the client already has.
 *
 * Filter semantics: callers MUST pass `conversationId` or `runId`
 * (or both). Both filters are applied with OR — a row matches if it
 * belongs to the named conversation OR the named run. This lets the
 * client follow a single run across its parent conversation without
 * a second round-trip when both ids are known.
 *
 * Ordering: ASCENDING by `(created_at, id)` so the client can append
 * directly to the feed. `id` is the tie-breaker for events with the
 * same `created_at` — `crypto.randomUUID()` is monotonic enough for
 * our purposes (and `emitActivity` generates ids in order anyway).
 */
export function registerGetRecentActivityTool(agent: CMO): void {
  const InputSchema = z
    .object({
      conversationId: z.string().optional(),
      runId: z.string().optional(),
      sinceMs: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(1000).optional(),
    })
    .refine((v) => v.conversationId !== undefined || v.runId !== undefined, {
      message: "conversationId or runId required",
    });

  agent.server.registerTool(
    "getRecentActivity",
    {
      description:
        "Read the tail of the activity_events table for a conversation or " +
        "run. Used by the web client to seed the activity feed on mount " +
        "and after reconnect. Returns oldest-first so the client can " +
        "append directly.",
      // McpServer.registerTool accepts a ZodRawShape for `inputSchema` —
      // the runtime validation (the `.refine` cross-field rule) happens
      // inside the handler via `InputSchema.parse()`. The shape declared
      // here drives the public tool metadata (JSON Schema generation).
      inputSchema: {
        conversationId: z.string().optional(),
        runId: z.string().optional(),
        sinceMs: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async (args) => {
      const parsed = InputSchema.parse(args);
      const sinceMs = parsed.sinceMs ?? 0;
      const limit = parsed.limit ?? 200;
      // SqlStorage placeholders don't accept `undefined` — pass nulls for
      // the unused filter and rely on the `? IS NOT NULL` guards in the
      // WHERE clause so the unused predicate doesn't match anything.
      const conv = parsed.conversationId ?? null;
      const run = parsed.runId ?? null;

      const rows = agent.sqlStorage
        .exec<{
          id: string;
          conversation_id: string | null;
          parent_turn_id: string | null;
          run_id: string | null;
          source_agent: string;
          parent_event_id: string | null;
          kind: string;
          payload_json: string;
          created_at: number;
        }>(
          `SELECT id, conversation_id, parent_turn_id, run_id, source_agent,
                  parent_event_id, kind, payload_json, created_at
           FROM activity_events
           WHERE ((? IS NOT NULL AND conversation_id = ?)
                  OR (? IS NOT NULL AND run_id = ?))
             AND created_at > ?
           ORDER BY created_at ASC, id ASC
           LIMIT ?`,
          conv,
          conv,
          run,
          run,
          sinceMs,
          limit,
        )
        .toArray()
        .map((r) => ({
          id: r.id,
          createdAt: r.created_at,
          conversationId: r.conversation_id,
          parentTurnId: r.parent_turn_id,
          runId: r.run_id,
          sourceAgent: r.source_agent,
          parentEventId: r.parent_event_id,
          kind: r.kind,
          payload: JSON.parse(r.payload_json) as unknown,
        }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows) }],
      };
    },
  );
}
