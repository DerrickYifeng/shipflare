// Sleep — yields a teammate's BullMQ worker slot mid-conversation (Phase D Task 1).
//
// Spec: `docs/superpowers/plans/2026-05-02-agent-teams-phase-d-sleep-resume.md` § Task 1
// + `docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md` § Phase D, §3.1.
//
// Effect on execute():
//   1. Validate `duration_ms` (positive, ≤ 24h) — keeps a runaway agent
//      from parking a row in `sleeping` for years.
//   2. UPDATE `agent_runs.status='sleeping'` + `sleepUntil=now+duration`.
//      The agent-run processor (Task 4) sees this row state on resume and
//      routes through the wake/load-history path. Even if this process
//      crashes between the UPDATE and the BullMQ enqueue, the
//      reconcile-mailbox cron (Phase B Task 13) eventually wakes any row
//      with overdue `sleepUntil`.
//   3. enqueueAgentRun({agentId}, {jobId, delay}) — schedules the wake.
//      The deterministic jobId `sleep:<agentId>:<wakeAt>` collides with
//      any concurrent SendMessage→wake() within the BullMQ removeOnComplete
//      window so the earlier wake takes precedence and the delayed job
//      becomes a no-op (intended dedup).
//   4. Return `{slept: true, agentId, durationMs, wakeAt}` — the
//      agent-run loop (Task 4) sees this special marker and exits the
//      runAgent loop WITHOUT calling synthesizeTaskNotification (the
//      agent isn't done, just yielding).
//
// Caller identity: `agentId` is read from the ToolContext via the
// `callerAgentId` key. The agent-run processor (Task 4) is responsible
// for injecting that key on every fork — Sleep is meaningless without
// it (we'd be marking an unrelated row as sleeping).
//
// Role permissions: Sleep is allowed for team-lead + teammate but NOT
// for subagent (subagents must complete in-turn, no yield). Enforced by
// adding SLEEP_TOOL_NAME to INTERNAL_SUBAGENT_TOOLS in Task 2 — this
// file does no role check itself.

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolContext, ToolDefinition } from '@/core/types';
import { db as defaultDb, type Database } from '@/lib/db';
import { agentRuns } from '@/lib/db/schema';
import { enqueueAgentRun } from '@/lib/queue/agent-run';
import { cacheTeammateStatus } from '@/workers/processors/lib/team-state-writethrough';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const SLEEP_TOOL_NAME = 'Sleep';

const MAX_DURATION_MS = 24 * 3600 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const SleepInputSchema = z
  .object({
    /**
     * Milliseconds to sleep before the BullMQ-scheduled wake fires. Must
     * be positive and ≤ 24h. SendMessages to this agent during the sleep
     * window also wake it early via the per-row jobId dedup path.
     */
    duration_ms: z.number().int(),
  })
  .strict();

export type SleepInput = z.infer<typeof SleepInputSchema>;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface SleepResult {
  slept: true;
  agentId: string;
  durationMs: number;
  wakeAt: Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readDb(ctx: ToolContext): Database {
  try {
    return ctx.get<Database>('db');
  } catch {
    return defaultDb;
  }
}

function readAgentId(ctx: ToolContext): string {
  return ctx.get<string>('callerAgentId');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const sleepTool: ToolDefinition<SleepInput, SleepResult> = buildTool({
  name: SLEEP_TOOL_NAME,
  description:
    "Yield this teammate's worker slot for a duration. The transcript is " +
    'persisted; new SendMessages or sleep expiry will resume the agent. ' +
    "Use when waiting for a peer's response or for an external event. " +
    'Each wake-up costs an API call — do not Sleep for less than ~5 seconds.',
  inputSchema: SleepInputSchema,
  // UPDATE + enqueue side effects; not safe to run concurrently for the
  // same agent (two parallel Sleeps would race the status row).
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input, ctx): Promise<SleepResult> {
    if (input.duration_ms <= 0) {
      throw new Error('Sleep: duration_ms must be positive');
    }
    if (input.duration_ms > MAX_DURATION_MS) {
      throw new Error(
        `Sleep: duration_ms ${input.duration_ms} exceeds 24-hour limit (${MAX_DURATION_MS}ms)`,
      );
    }

    const agentId = readAgentId(ctx);
    const db = readDb(ctx);
    const wakeAt = new Date(Date.now() + input.duration_ms);
    const sleptAt = new Date();

    // 1. Mark sleeping. Even if the processor crashes between this UPDATE
    //    and the early-exit path in Task 4, status='sleeping' is the
    //    correct fail-safe state — reconcile-mailbox will eventually
    //    re-enqueue an overdue sleepUntil row.
    await db
      .update(agentRuns)
      .set({
        status: 'sleeping',
        sleepUntil: wakeAt,
        lastActiveAt: sleptAt,
      })
      .where(eq(agentRuns.id, agentId));

    // 2. Schedule the delayed wake. The deterministic jobId collapses
    //    near-simultaneous SendMessage→wake() calls onto the same job
    //    within BullMQ's removeOnComplete window — the earlier wake
    //    wins; the delayed job no-ops if the agent is already running.
    await enqueueAgentRun(
      { agentId },
      {
        jobId: `sleep:${agentId}:${wakeAt.getTime()}`,
        delay: input.duration_ms,
      },
    );

    // 3. UI-D: cache write-through. Teammate yielded its slot — patch the
    //    cached roster so the status pill flips to "sleeping" without a
    //    DB roundtrip on the next read. We need the teamId for the cache
    //    key; read it back from the row we just updated. Lookup failure
    //    is non-fatal: the writethrough is an optimization, not a
    //    correctness requirement (60s TTL is the safety net).
    try {
      const rows = await db
        .select({ teamId: agentRuns.teamId, agentDefName: agentRuns.agentDefName })
        .from(agentRuns)
        .where(eq(agentRuns.id, agentId))
        .limit(1);
      if (rows.length > 0 && rows[0].agentDefName !== 'coordinator') {
        // Sleep is allowed for both lead + teammate, but the cached
        // roster only tracks teammates explicitly — the lead's status
        // is rendered via leadStatus, which the agent-run worker's
        // writethrough handles when it observes the sleepingExit early
        // return. Skip here for the lead to avoid double-writing.
        await cacheTeammateStatus(
          rows[0].teamId,
          agentId,
          'sleeping',
          sleptAt,
          wakeAt,
        );
      }
    } catch {
      // Best-effort. The agent-run worker's sleepingExit branch will
      // also call the writethrough on its way out, so this is belt-
      // and-suspenders.
    }

    return {
      slept: true,
      agentId,
      durationMs: input.duration_ms,
      wakeAt,
    };
  },
});
