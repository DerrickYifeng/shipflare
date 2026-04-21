// Reply-sweep scheduler — idempotent helper that enqueues a reply_sweep
// team_run for a user whose team is provisioned and whose discovery
// pipeline has produced recent threads worth looking at.
//
// Called by:
//   - `src/workers/processors/reply-sweep-cron.ts` — 6h fan-out
//   - Future API routes that let the founder manually trigger a sweep
//
// Throttling: skip if the user has a reply_sweep run that started in
// the last `REPLY_SWEEP_THROTTLE_MS`. This is defense in depth — the
// `idx_team_runs_one_running_per_team` partial unique index already
// prevents double-fires within a single active run, but that only
// covers the currently-running window, not the "we just finished one
// 10 minutes ago" case.
//
// Threads signal: skip if the user's inbox has zero threads newer than
// `REPLY_SWEEP_INBOX_WINDOW_MS`. A sweep with nothing to review wastes
// budget — better to wait for the discovery pipeline to land
// something first.

import { and, desc, eq, gte } from 'drizzle-orm';
import { db as defaultDb, type Database } from '@/lib/db';
import { teamMembers, teamRuns, teams, threads } from '@/lib/db/schema';
import { enqueueTeamRun as defaultEnqueueTeamRun } from '@/lib/queue/team-run';
import type { EnqueueTeamRunInput, EnqueueTeamRunResult } from '@/lib/queue/team-run';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:reply-sweep');

/** Cron cadence from spec §4.2: every 6h per user. */
export const REPLY_SWEEP_THROTTLE_MS = 6 * 60 * 60 * 1000;

/** Only fire a sweep when there's a thread discovered in the last 24h. */
export const REPLY_SWEEP_INBOX_WINDOW_MS = 24 * 60 * 60 * 1000;

export type MaybeEnqueueReplySweepResult =
  | { status: 'enqueued'; runId: string; teamId: string }
  | {
      status: 'skipped';
      teamId: string | null;
      reason:
        | 'no_team'
        | 'no_coordinator'
        | 'throttled'
        | 'already_running'
        | 'empty_inbox';
    };

export interface MaybeEnqueueReplySweepDeps {
  /** DB handle — injected by tests; defaults to the shared `db`. */
  db?: Database;
  /** enqueueTeamRun hook — injected by tests to avoid touching Redis. */
  enqueueTeamRun?: (input: EnqueueTeamRunInput) => Promise<EnqueueTeamRunResult>;
}

/**
 * Try to enqueue a reply_sweep team_run for the given userId.
 *
 * Resolves which team to target, resolves the team's coordinator, and
 * calls `enqueueTeamRun` through the same path any other trigger uses
 * (`/api/team/run` and the weekly-replan worker share the same helper).
 *
 * Idempotent and defensive: safe to call on every 6h cron tick for
 * every user. Returns a structured result so the caller can log the
 * skip reason without parsing logs.
 */
export async function maybeEnqueueReplySweep(
  userId: string,
  deps: MaybeEnqueueReplySweepDeps = {},
): Promise<MaybeEnqueueReplySweepResult> {
  const db = deps.db ?? defaultDb;
  const enqueueTeamRun = deps.enqueueTeamRun ?? defaultEnqueueTeamRun;
  // 1. Resolve the user's team.
  const teamRows = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.userId, userId))
    .limit(1);
  const team = teamRows[0];
  if (!team) {
    return { status: 'skipped', teamId: null, reason: 'no_team' };
  }

  // 2. Resolve the coordinator member_id. Same logic as
  //    /api/team/run — prefer coordinator, else skip (sweeps without a
  //    root agent aren't useful, unlike manual triggers which can fall
  //    back to any member).
  const coordinators = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, team.id),
        eq(teamMembers.agentType, 'coordinator'),
      ),
    )
    .limit(1);
  const coordinator = coordinators[0];
  if (!coordinator) {
    return { status: 'skipped', teamId: team.id, reason: 'no_coordinator' };
  }

  // 3. Throttle — skip if we already kicked off a reply_sweep recently.
  const throttleCutoff = new Date(Date.now() - REPLY_SWEEP_THROTTLE_MS);
  const recentRuns = await db
    .select({ id: teamRuns.id, status: teamRuns.status, startedAt: teamRuns.startedAt })
    .from(teamRuns)
    .where(
      and(
        eq(teamRuns.teamId, team.id),
        eq(teamRuns.trigger, 'reply_sweep'),
        gte(teamRuns.startedAt, throttleCutoff),
      ),
    )
    .orderBy(desc(teamRuns.startedAt))
    .limit(1);
  if (recentRuns.length > 0) {
    return { status: 'skipped', teamId: team.id, reason: 'throttled' };
  }

  // 4. Empty-inbox check — skip if no threads were discovered recently.
  //    We don't need to count precisely; a single "hit" is enough.
  const inboxCutoff = new Date(Date.now() - REPLY_SWEEP_INBOX_WINDOW_MS);
  const inboxRows = await db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.userId, userId),
        gte(threads.discoveredAt, inboxCutoff),
      ),
    )
    .limit(1);
  if (inboxRows.length === 0) {
    return { status: 'skipped', teamId: team.id, reason: 'empty_inbox' };
  }

  // 5. Enqueue. enqueueTeamRun handles the "one running per team"
  //    partial unique index — if a different trigger (weekly, manual,
  //    onboarding) is active, it returns alreadyRunning=true and we
  //    surface that as a skip so the cron tick doesn't treat a concurrent
  //    run as a success.
  const result = await enqueueTeamRun({
    teamId: team.id,
    trigger: 'reply_sweep',
    goal:
      `Scan connected channels for new high-signal threads and draft replies ` +
      `for the ones that pass the three-gate quality bar (potential user + ` +
      `specific anchor + reply window open). Persist drafts as pending rows ` +
      `for founder approval. Skip threads that don't clear the bar — zero ` +
      `drafts from a healthy-looking sweep is a valid outcome.`,
    rootMemberId: coordinator.id,
  });

  if (result.alreadyRunning) {
    return { status: 'skipped', teamId: team.id, reason: 'already_running' };
  }

  log.info(
    `reply_sweep enqueued for user=${userId} team=${team.id} runId=${result.runId}`,
  );
  return { status: 'enqueued', runId: result.runId, teamId: team.id };
}
