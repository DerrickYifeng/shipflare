import { AsyncLocalStorage } from "node:async_hooks";
import type { ActivityEventInput } from "@shipflare/shared";

/**
 * Trace context propagated across async boundaries via AsyncLocalStorage.
 *
 * Spec: 2026-05-15-agent-activity-feed-design.md §5.5.
 *
 * The four fields mirror the columns on `activity_events` that connect
 * a child event to its parent turn / run / conversation. Helpers
 * downstream (e.g. tool-call wrappers, subagent dispatch) read this
 * context to populate event ancestry without threading every parameter
 * through every function signature.
 */
export interface TraceContext {
  runId: string | null;
  parentEventId: string | null;
  conversationId: string | null;
  parentTurnId: string | null;
}

const TRACE_ALS = new AsyncLocalStorage<TraceContext>();

/**
 * Returns the trace context active on the current async scope, or `null`
 * if called outside a `withTraceContext` block.
 */
export function currentTraceContext(): TraceContext | null {
  return TRACE_ALS.getStore() ?? null;
}

/**
 * Runs `fn` with `ctx` as the active trace context. Any
 * `currentTraceContext()` call inside `fn` (including across awaits)
 * returns `ctx`. Nesting replaces the parent context for the duration
 * of the inner scope.
 *
 * `node:async_hooks.AsyncLocalStorage` is available in Cloudflare
 * Workers because `wrangler.jsonc` enables the `nodejs_compat`
 * compatibility flag.
 */
export async function withTraceContext<T>(
  ctx: TraceContext,
  fn: () => Promise<T>,
): Promise<T> {
  return TRACE_ALS.run(ctx, fn);
}

/**
 * Structural shape of a host that can persist + broadcast activity events.
 *
 * We deliberately do NOT import the CMO class here: CMO imports
 * `emitActivity`, so the reverse import would create a cycle. The
 * structural interface lets us write to `sqlStorage` (a `SqlStorage`
 * binding under the hood) and `broadcast` (Agents SDK WebSocket
 * fan-out) without depending on the concrete DO class.
 */
interface ActivityHost {
  sqlStorage: {
    exec: (q: string, ...args: unknown[]) => { toArray: () => unknown[] };
  };
  broadcast: (msg: string) => void;
}

/**
 * Per-DO last emit timestamp — guarantees `createdAt` is strictly monotonic
 * per CMO instance. Without this, two events emitted in the same millisecond
 * would tie on created_at; the SQL tiebreaker (id ASC, where id is UUIDv4)
 * would then sort them randomly. WeakMap is keyed by agent so each CMO DO
 * has its own counter, with no cross-DO interference.
 */
const LAST_EMIT_MS = new WeakMap<object, number>();

/**
 * Single sanctioned writer for activity events.
 *
 * Spec: 2026-05-15-agent-activity-feed-design.md §5.1.
 *
 * Contract:
 *   1. INSERTs a row into the CMO DO's `activity_events` table.
 *   2. Broadcasts the materialized `ActivityEvent` (with generated `id`
 *      and `createdAt`) to all connected WS clients on this DO.
 *
 * The caller MUST already be running inside the CMO DO so that
 * `agent.sqlStorage` is the CMO's local `SqlStorage`. Code on other
 * DOs (or workers) MUST forward the event over RPC / fetch — direct
 * cross-DO SQL access is forbidden by CLAUDE.md's architecture rules.
 *
 * Ordering guarantee: `createdAt` is strictly monotonic per host. If
 * `Date.now()` has not advanced since the last emit (same-millisecond
 * bursts on fast hardware), the new event's `createdAt` is bumped to
 * `prev + 1`. This makes `(created_at ASC, id ASC)` ordering on reads
 * deterministic without relying on UUIDv4 as a tiebreaker.
 */
export async function emitActivity(
  agent: ActivityHost,
  input: ActivityEventInput,
): Promise<void> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const prev = LAST_EMIT_MS.get(agent as object) ?? 0;
  const createdAt = now > prev ? now : prev + 1;
  LAST_EMIT_MS.set(agent as object, createdAt);

  agent.sqlStorage.exec(
    `INSERT INTO activity_events
       (id, conversation_id, parent_turn_id, run_id, source_agent, parent_event_id, kind, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.conversationId,
    input.parentTurnId,
    input.runId,
    input.sourceAgent,
    input.parentEventId,
    input.kind,
    JSON.stringify(input.payload),
    createdAt,
  );

  agent.broadcast(JSON.stringify({ id, createdAt, ...input }));
}
