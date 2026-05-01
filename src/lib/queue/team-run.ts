// Phase A Day 4 — BullMQ queue handle + enqueue helper for team-runs.
// See spec §4.1, §6.1, §11 Phase A Day 4.

import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getBullMQConnection } from '@/lib/redis';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/db';
import { teamRuns } from '@/lib/db/schema';

const log = createLogger('lib:queue:team-run');

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export const TEAM_RUN_QUEUE_NAME = 'team-runs';

export const teamRunJobSchema = z.object({
  runId: z.string().min(1),
  /** Optional correlation id — convenient for log lines; persisted on team_runs.trace_id. */
  traceId: z.string().optional(),
});

export type TeamRunJobData = z.infer<typeof teamRunJobSchema>;

export const teamRunQueue = new Queue<TeamRunJobData>(TEAM_RUN_QUEUE_NAME, {
  connection: getBullMQConnection(),
  defaultJobOptions: {
    removeOnComplete: { count: 200, age: 24 * 3600 },
    removeOnFail: { count: 1000, age: 7 * 24 * 3600 },
    // One retry max — team_runs are expensive (N LLM turns) and
    // idempotent-ish (the processor ignores runs whose status isn't pending).
    attempts: 1,
  },
});

// ---------------------------------------------------------------------------
// enqueueTeamRun
// ---------------------------------------------------------------------------

export type TeamRunTrigger =
  | 'onboarding'
  | 'kickoff'
  | 'weekly'
  | 'daily'
  | 'phase_transition'
  | 'draft_post';

export interface EnqueueTeamRunInput {
  teamId: string;
  trigger: TeamRunTrigger;
  goal: string;
  /**
   * The team_members.id of the root agent (typically the coordinator). Must be
   * a member of the same team. The worker will construct its ToolContext with
   * `currentMemberId = rootMemberId`.
   */
  rootMemberId: string;
  /**
   * The conversation this run lives inside. REQUIRED as of the chat
   * refactor — there's no longer any "infer which conversation"
   * fallback path. Callers must create or look up the conversation
   * before enqueueing a run for it.
   */
  conversationId: string;
}

export interface EnqueueTeamRunResult {
  runId: string;
  traceId: string;
  /**
   * True when `enqueueTeamRun` detected an existing running row on the same
   * team and returned its runId instead of inserting a new one. Callers that
   * want strict "fail if busy" semantics should check this flag and surface
   * a 409 accordingly.
   */
  alreadyRunning: boolean;
}

/**
 * Create a team_runs row (status='pending') and enqueue a BullMQ job to
 * execute it. Honors spec §16's "one running team_run per team" constraint:
 * if a run is already in-flight on the team, returns its runId with
 * `alreadyRunning: true` instead of inserting a duplicate.
 *
 * Trace id flows: generated here → stored on team_runs.trace_id → carried in
 * the job payload so the worker's log lines and the HTTP response agree.
 */
export async function enqueueTeamRun(
  input: EnqueueTeamRunInput,
): Promise<EnqueueTeamRunResult> {
  // Check for an existing running row. The partial unique index
  // (idx_team_runs_one_running_per_team) enforces this at the DB layer; we
  // check first to return the existing id rather than catching the unique
  // violation after the fact.
  const running = await db
    .select({ id: teamRuns.id, traceId: teamRuns.traceId })
    .from(teamRuns)
    .where(and(eq(teamRuns.teamId, input.teamId), eq(teamRuns.status, 'running')))
    .limit(1);

  if (running.length === 1) {
    const existing = running[0];
    log.info(
      `enqueueTeamRun: team ${input.teamId} already has running run ${existing.id} — returning existing id`,
    );
    return {
      runId: existing.id,
      traceId: existing.traceId ?? '',
      alreadyRunning: true,
    };
  }

  const runId = crypto.randomUUID();
  const traceId = randomUUID();

  await db.insert(teamRuns).values({
    id: runId,
    teamId: input.teamId,
    conversationId: input.conversationId,
    trigger: input.trigger,
    goal: input.goal,
    rootAgentId: input.rootMemberId,
    status: 'pending',
    traceId,
  });

  const payload: TeamRunJobData = teamRunJobSchema.parse({ runId, traceId });
  await teamRunQueue.add('run', payload, {
    jobId: `team-run-${runId}`,
  });

  log.info(`enqueueTeamRun: enqueued runId=${runId} team=${input.teamId} trigger=${input.trigger}`);
  return { runId, traceId, alreadyRunning: false };
}
