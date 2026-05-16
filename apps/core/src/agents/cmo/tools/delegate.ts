import { z } from "zod";
import { isValidRole, mcpServerName, type RoleSlug } from "@shipflare/shared";
import type { CMO } from "../CMO";
import { emitActivity } from "../../../lib/activity";

/**
 * delegateToEmployee — CMO → employee RPC.
 *
 * The CMO uses this to hand a task off to a specialist (HoG for strategy,
 * SMM for execution, etc.). The receiver is an `McpServer` connected via
 * `addMcpServer` during `onStart` (per-tenant namespaced).
 *
 * Per the Agents SDK (`agents@0.12.x`), the way to invoke a tool on a
 * connected MCP server is `agent.mcp.callTool({ serverId, name, arguments })`
 * where `serverId` is the UUID returned by `addMcpServer`. Because
 * `connectEmployees()` is fire-and-forget (doesn't persist the returned id),
 * we look the server up by its namespaced `name` via `agent.mcp.listServers()`
 * — that name is `mcpServerName(role, userId)`, identical to what
 * `connectEmployees` passed in.
 *
 * Logs each delegation result to `employee_log` so the next founder chat
 * turn can reference it via `query_team_status`-style tools (later).
 *
 * Activity instrumentation (Task 8, spec 2026-05-15-agent-activity-feed-design.md):
 *
 *   - Role validation runs FIRST. Unknown roles / self-delegation throw
 *     before any activity row is written.
 *   - `subagent_dispatch` is emitted BEFORE the in-process MCP call (and
 *     even before the userId / server-lookup checks) so the feed shows
 *     every delegation ATTEMPT, including misconfigurations. The
 *     dispatch event's id is captured as `dispatchEventId` and threaded
 *     into the inner call's `args._trace.parentEventId`, letting child
 *     agents (HoG / SMM) attach their own events under it.
 *   - `subagent_finish` is emitted on both success and failure paths.
 *     On error it carries `status: 'error'` and a truncated `summary`.
 *   - Both emits are wrapped in defensive try/catch so a transient
 *     telemetry failure (e.g. SQLite contention) doesn't blow up the
 *     delegation itself — failures are logged via `console.warn`.
 *
 * The dispatch + finish events are top-level (parentEventId = null on
 * the rows themselves); they're SIBLINGS, not nested. The link from
 * child agent events back to the dispatch happens via the inner call's
 * `_trace.parentEventId`, persisted by the child's own `emitActivity`
 * calls.
 */
export function registerDelegationTools(agent: CMO): void {
  agent.server.registerTool(
    "delegateToEmployee",
    {
      description:
        "Hand a task off to a specific employee role. The role must be an active hire. " +
        "The employee's tool returns its result; this CMO logs the summary to employee_log.",
      inputSchema: {
        role: z.string(),
        tool: z.string(),
        args: z.record(z.string(), z.unknown()),
        conversationId: z.string().optional(),
      },
    },
    async ({ role, tool, args, conversationId }) => {
      // Role validation runs BEFORE any activity emit — unknown / self-targets
      // are caller bugs, not delegation attempts worth surfacing in the feed.
      if (!isValidRole(role)) {
        throw new Error(`Unknown role: ${role}`);
      }
      if (role === "cmo") {
        throw new Error("Cannot delegate to self");
      }

      // Emit `subagent_dispatch` FIRST so the activity feed shows the
      // delegation attempt regardless of whether the inner call ultimately
      // succeeds, fails, or is blocked by misconfiguration (missing
      // userId, employee not hired, etc.).
      const dispatchEventId = crypto.randomUUID();
      const dispatchStart = Date.now();
      const promptPreview = computePromptPreview(args);
      try {
        await emitActivity(agent, {
          conversationId: conversationId ?? null,
          parentTurnId: null,
          runId: null,
          sourceAgent: "cmo",
          parentEventId: null,
          kind: "subagent_dispatch",
          payload: {
            kind: "subagent_dispatch",
            subAgent: role,
            promptPreview,
          },
        });
      } catch (e) {
        console.warn("[delegate] dispatch emit failed:", e);
      }

      try {
        const userId = agent.props?.userId;
        if (!userId) {
          throw new Error("CMO has no userId in props; cannot delegate");
        }

        // Resolve serverId from the namespaced name. `listServers()` is the
        // SDK's source of truth for connected MCP servers (in-memory + storage).
        const targetName = mcpServerName(role as RoleSlug, userId);
        const server = agent.mcp
          .listServers()
          .find((s) => s.name === targetName);
        if (!server) {
          throw new Error(
            `Employee "${role}" is not connected. Hire them first via hireEmployee.`,
          );
        }

        // Thread trace context into the inner call so the child agent's
        // own `emitActivity` calls can link back to this dispatch event.
        const argsWithTrace = {
          ...(args as Record<string, unknown>),
          _trace: {
            runId: null,
            parentEventId: dispatchEventId,
            conversationId: conversationId ?? null,
            parentTurnId: null,
            userId,
          },
        };

        // Call the requested tool on the employee.
        const result = await agent.mcp.callTool({
          serverId: server.id,
          name: tool,
          arguments: argsWithTrace,
        });

        // Log the delegation to employee_log.
        const summary = `${role}.${tool} returned`;
        agent.sqlStorage.exec(
          `INSERT INTO employee_log (conversation_id, from_role, kind, summary, payload_json, ts)
           VALUES (?, ?, 'task_complete', ?, ?, ?)`,
          conversationId ?? null,
          role,
          summary,
          JSON.stringify({ tool, args, result }),
          Date.now(),
        );

        // Emit `subagent_finish` (success). Defensive try/catch — a
        // telemetry hiccup here should NOT mask the successful result.
        try {
          await emitActivity(agent, {
            conversationId: conversationId ?? null,
            parentTurnId: null,
            runId: null,
            sourceAgent: "cmo",
            parentEventId: null,
            kind: "subagent_finish",
            payload: {
              kind: "subagent_finish",
              subAgent: role,
              status: "ok",
              durationMs: Date.now() - dispatchStart,
              summary,
            },
          });
        } catch (e) {
          console.warn("[delegate] finish emit failed:", e);
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        // Emit `subagent_finish` with `status: 'error'` BEFORE re-throwing
        // so the feed shows the failed delegation. Truncate the error
        // message to keep payload_json small.
        const summary = (
          err instanceof Error ? err.message : String(err)
        ).slice(0, 200);
        try {
          await emitActivity(agent, {
            conversationId: conversationId ?? null,
            parentTurnId: null,
            runId: null,
            sourceAgent: "cmo",
            parentEventId: null,
            kind: "subagent_finish",
            payload: {
              kind: "subagent_finish",
              subAgent: role,
              status: "error",
              durationMs: Date.now() - dispatchStart,
              summary,
            },
          });
        } catch (e) {
          console.warn("[delegate] error-finish emit failed:", e);
        }
        throw err;
      }
    },
  );
}

/**
 * Compute a 200-char preview of the delegation payload for the activity
 * feed. Prefers the conventional `message` field (the standard "what to
 * do" prompt for sub-agents); falls back to a JSON snapshot.
 */
function computePromptPreview(args: unknown): string {
  if (args && typeof args === "object" && "message" in args) {
    const msg = (args as Record<string, unknown>).message;
    return String(msg ?? "").slice(0, 200);
  }
  try {
    return JSON.stringify(args).slice(0, 200);
  } catch {
    return "";
  }
}
