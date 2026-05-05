// TaskStop — lead-only graceful-stop lever for a teammate (Phase C Task 6).
//
// Spec: `docs/superpowers/plans/2026-05-02-agent-teams-phase-c-sendmessage-protocol.md` § Task 6
// + `docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md` § Phase C.
//
// Effect on execute():
//   1. INSERT a `shutdown_request` row addressed to the teammate's
//      `agent_runs.id` (toAgentId). The teammate's mailbox-drain hook
//      (Phase C Task 7) picks it up at the next idle turn and exits
//      gracefully — final transcript is preserved, status='killed'.
//   2. UPDATE `agent_runs.status='killed'` with `shutdownReason`. This
//      is the durable record; the BullMQ job is best-effort cancelled
//      via the wake/idle path (no direct queue eviction in Phase C).
//   3. WAKE the target so it processes the shutdown_request promptly
//      rather than waiting for the reconcile-mailbox cron tick.
//
// Architectural rule (engine PDF §2.4): TaskStop is restricted to the
// team-lead. Teammates cannot stop peers — that authority lives strictly
// with the lead. Enforced via `validateInput` reading `callerRole` from
// the ToolContext (engine fail-closed: missing key => 403).
//
// Blacklisted from teammate tool pools via `INTERNAL_TEAMMATE_TOOLS` in
// `src/tools/AgentTool/blacklists.ts` — second layer of defense beneath
// the runtime validateInput check.

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type {
  ToolContext,
  ToolDefinition,
  ValidationResult,
} from '@/core/types';
import { createLogger } from '@/lib/logger';
import { db as defaultDb, type Database } from '@/lib/db';
import { agentRuns, teamMessages } from '@/lib/db/schema';
import { wake } from '@/workers/processors/lib/wake';

const log = createLogger('tools:TaskStop');

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const TASK_STOP_TOOL_NAME = 'TaskStop';

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const TaskStopInputSchema = z
  .object({
    /**
     * `agent_runs.id` of the teammate to stop. The lead obtains this from
     * the `<task-notification>` envelope of the spawn (`task_id` attribute)
     * or from `query_team_status` results.
     */
    task_id: z
      .string()
      .min(1, 'task_id is required (= agent_runs.id of the teammate to stop)'),
  })
  .strict();

export type TaskStopInput = z.infer<typeof TaskStopInputSchema>;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface TaskStopResult {
  stopped: true;
  task_id: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TaskStopDeps {
  db: Database;
  teamId: string;
  fromMemberId: string | null;
}

/**
 * Read the live deps from the ToolContext. `teamId` is required; the
 * other two are optional (legacy callers that haven't wired everything
 * yet still produce a usable, if attribution-light, stop).
 */
function readDeps(ctx: ToolContext): TaskStopDeps {
  const teamId = ctx.get<string>('teamId');

  let database: Database = defaultDb;
  try {
    database = ctx.get<Database>('db');
  } catch {
    // Default to the app-wide singleton.
  }

  let fromMemberId: string | null = null;
  try {
    fromMemberId = ctx.get<string>('currentMemberId');
  } catch {
    fromMemberId = null;
  }

  return { db: database, teamId, fromMemberId };
}

/**
 * Read the caller's team role from the ToolContext.
 *
 * Phase C engine fail-closed pattern: when the runner has not injected
 * `callerRole`, return `null`. The caller of this helper (`validateInput`)
 * then rejects the call — TaskStop never falls through to a permissive
 * default.
 */
function getCallerRole(ctx: ToolContext): 'lead' | 'member' | null {
  try {
    return ctx.get<'lead' | 'member'>('callerRole');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const taskStopTool: ToolDefinition<TaskStopInput, TaskStopResult> =
  buildTool({
    name: TASK_STOP_TOOL_NAME,
    description:
      'Stop a running teammate gracefully. Writes a shutdown_request to ' +
      "the target's mailbox (the teammate processes it on its next idle " +
      'turn and exits cleanly), marks agent_runs.status=killed, and wakes ' +
      'the target so it processes the request promptly. Lead-only — ' +
      'teammates cannot stop peers.',
    inputSchema: TaskStopInputSchema,
    // INSERTs + UPDATEs + wakes — unambiguously side-effecting, not safe
    // to run concurrently for the same task_id.
    isConcurrencySafe: false,
    isReadOnly: false,
    async validateInput(_input, ctx): Promise<ValidationResult> {
      const role = getCallerRole(ctx);
      if (role !== 'lead') {
        return {
          result: false,
          errorCode: 403,
          message:
            'TaskStop is restricted to team-lead. Teammates cannot stop ' +
            'peers — that authority lives strictly with the lead.',
        };
      }
      return { result: true };
    },
    async execute(input, ctx): Promise<TaskStopResult> {
      const { db, teamId, fromMemberId } = readDeps(ctx);

      // 1. INSERT shutdown_request row to target's mailbox.
      //    The teammate's idle-turn drain (Phase C Task 7) picks this up
      //    and exits gracefully (status='killed' notification synthesized
      //    server-side, never via SyntheticOutput).
      await db.insert(teamMessages).values({
        teamId,
        type: 'user_prompt',
        messageType: 'shutdown_request',
        fromMemberId,
        toAgentId: input.task_id,
        content:
          'Stop requested by team-lead. Wrap up gracefully and exit at ' +
          'the next safe boundary.',
        summary: 'TaskStop',
      });

      // 2. UPDATE agent_runs.status='killed' with shutdownReason. This is
      //    the durable record — even if the teammate is mid-turn and the
      //    drain doesn't fire for a beat, the row already reflects the
      //    intent. The teammate's loop checks status before each turn and
      //    bails if it sees 'killed'.
      await db
        .update(agentRuns)
        .set({
          status: 'killed',
          shutdownReason: 'TaskStop by lead',
          lastActiveAt: new Date(),
        })
        .where(eq(agentRuns.id, input.task_id));

      // 3. WAKE the target so it processes the shutdown_request promptly
      //    rather than idling until the reconcile-mailbox cron tick. Wake
      //    is idempotent within a 1-second window via BullMQ jobId dedupe;
      //    failures inside wake() are swallowed and logged, the cron is
      //    the durable backstop.
      try {
        await wake(input.task_id);
      } catch (err) {
        // Defense in depth: even if wake() throws (it shouldn't — its own
        // implementation logs and swallows), we don't want to leak the
        // failure back to the caller. The shutdown_request row + the
        // status='killed' UPDATE are the durable contract; wake is purely
        // a latency optimization.
        log.warn(
          `TaskStop wake() failed for task_id=${input.task_id}; reconcile-mailbox cron will pick it up: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      return { stopped: true, task_id: input.task_id };
    },
  });
