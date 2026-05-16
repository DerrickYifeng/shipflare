import type { Env } from "../index";
import { forwardActivityToCmo } from "./forward-activity";

/**
 * Trace context propagated from the CMO into sub-agent tool calls via
 * `delegateToEmployee` (Task 8). When a sub-agent tool wants to emit
 * activity events that nest under the original founder turn, it pulls
 * this shape out of its `args._trace` and forwards events through
 * `withSubAgentToolTracing`.
 */
export interface SubAgentTrace {
  runId: string | null;
  parentEventId: string | null;
  conversationId: string | null;
  parentTurnId: string | null;
  userId: string;
}

/**
 * Pull the `_trace` arg embedded by CMO.delegateToEmployee (Task 8) out of
 * a sub-agent tool's input. Returns null if no trace was supplied — sub-agent
 * tools should treat that as "no instrumentation, run as usual".
 *
 * IMPORTANT: For `_trace` to actually reach the handler, the sub-agent tool's
 * `inputSchema` MUST declare `_trace: z.unknown().optional()` (or include
 * it via .passthrough()). Without that declaration the MCP SDK's Zod parser
 * strips `_trace` before the handler runs, and `extractTrace` will return
 * null. See `sub-agent-forwarding.test.ts` for the canonical example.
 *
 * TODO(activity-feed-followup): wrap production HoG/SMM tools with this
 * helper and add `_trace: z.unknown().optional()` to each tool's input
 * schema. Tools to wrap (non-exhaustive):
 *   HoG:  generate_strategic_path, audit_plan
 *   SMM:  find_threads_via_xai, find_threads, process_replies_batch,
 *         process_posts_batch, research_reddit_channels, list_drafts
 */
export function extractTrace(args: unknown): SubAgentTrace | null {
  if (!args || typeof args !== "object") return null;
  const t = (args as Record<string, unknown>)._trace;
  if (!t || typeof t !== "object") return null;
  const trace = t as Partial<SubAgentTrace>;
  if (typeof trace.userId !== "string") return null;
  return {
    userId: trace.userId,
    runId: typeof trace.runId === "string" ? trace.runId : null,
    parentEventId:
      typeof trace.parentEventId === "string" ? trace.parentEventId : null,
    conversationId:
      typeof trace.conversationId === "string" ? trace.conversationId : null,
    parentTurnId:
      typeof trace.parentTurnId === "string" ? trace.parentTurnId : null,
  };
}

/**
 * Wrap a sub-agent tool handler so the call emits
 * `subagent_tool_call_start` before `body()` runs and
 * `subagent_tool_call_finish` after it returns (success OR error).
 *
 * No-op when `trace` is null — the helper is safe to invoke even when
 * the caller did not embed `_trace` (e.g. direct MCP client calls
 * outside the CMO delegation path). Telemetry failures are swallowed
 * by `forwardActivityToCmo` itself; this helper never blocks real work.
 *
 * The body's return value is passed through untouched. If the body
 * throws, the finish event records `status: 'error'` and the error is
 * re-thrown so the caller still sees the failure.
 */
export async function withSubAgentToolTracing<T>(
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  env: Env,
  trace: SubAgentTrace | null,
  subAgent: string,
  toolName: string,
  args: unknown,
  body: () => Promise<T>,
): Promise<T> {
  if (!trace) return body();
  const start = Date.now();
  const argsPreview = ((): string => {
    try {
      return JSON.stringify(args).slice(0, 200);
    } catch {
      return "";
    }
  })();
  forwardActivityToCmo(ctx, env, trace.userId, {
    conversationId: trace.conversationId,
    parentTurnId: trace.parentTurnId,
    runId: trace.runId,
    sourceAgent: subAgent,
    parentEventId: trace.parentEventId,
    kind: "subagent_tool_call_start",
    payload: {
      kind: "subagent_tool_call_start",
      subAgent,
      tool: toolName,
      argsPreview,
    },
  });
  try {
    const out = await body();
    forwardActivityToCmo(ctx, env, trace.userId, {
      conversationId: trace.conversationId,
      parentTurnId: trace.parentTurnId,
      runId: trace.runId,
      sourceAgent: subAgent,
      parentEventId: trace.parentEventId,
      kind: "subagent_tool_call_finish",
      payload: {
        kind: "subagent_tool_call_finish",
        subAgent,
        tool: toolName,
        status: "ok",
        durationMs: Date.now() - start,
      },
    });
    return out;
  } catch (err) {
    forwardActivityToCmo(ctx, env, trace.userId, {
      conversationId: trace.conversationId,
      parentTurnId: trace.parentTurnId,
      runId: trace.runId,
      sourceAgent: subAgent,
      parentEventId: trace.parentEventId,
      kind: "subagent_tool_call_finish",
      payload: {
        kind: "subagent_tool_call_finish",
        subAgent,
        tool: toolName,
        status: "error",
        durationMs: Date.now() - start,
      },
    });
    throw err;
  }
}
