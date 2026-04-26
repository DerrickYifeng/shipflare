// Reply-sweep scheduler — idempotent helper that enqueues a reply_sweep
// team_run for a user whose team has at least one planned `content_reply`
// slot for today (the daily reply slot allocated by the content-planner
// based on `channelMix[ch].repliesPerDay`).
//
// Called by:
//   - `src/workers/processors/reply-sweep-cron.ts` — daily fan-out
//   - Future API routes that let the founder manually trigger a sweep
//
// Flow:
//   1. Resolve the user's team + product + coordinator member.
//   2. Find today's `content_reply` `plan_items` in state='planned'.
//      If none → skip (`no_slots_today`).
//   3. Throttle: skip if any `reply_sweep` team_run already started
//      today (UTC date) for this team (`throttled`).
//   4. Enqueue a `reply_sweep` team_run with a goal that lists each
//      slot's planItemId + channel + targetCount and instructs the
//      coordinator to run discovery → community-manager up to 3
//      inner attempts per slot, then flip the plan_item to
//      `state='drafted'` once filled or attempts exhausted.
//
// We intentionally do NOT pre-check the inbox for "recent threads".
// The new daily session runs discovery as its first step, so an empty
// inbox is fine — the coordinator's first action inside the run is to
// scan, not assume threads already exist.

import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { db as defaultDb, type Database } from '@/lib/db';
import { planItems, teamMembers, teamRuns, teams } from '@/lib/db/schema';
import { enqueueTeamRun as defaultEnqueueTeamRun } from '@/lib/queue/team-run';
import { createAutomationConversation } from '@/lib/team-conversation-helpers';
import type { EnqueueTeamRunInput, EnqueueTeamRunResult } from '@/lib/queue/team-run';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:reply-sweep');

/**
 * Compute UTC midnight bounds for "today" relative to `now`.
 *
 * We snap on UTC date rather than the user's local timezone because
 * the cron itself runs in UTC and the slots' `scheduledAt` were also
 * normalized to UTC by the content-planner. Using a single global
 * timezone for the throttle keeps the implementation deterministic
 * and avoids per-user timezone lookup on every fan-out tick.
 */
function todayUtcBounds(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

export type MaybeEnqueueReplySweepResult =
  | { status: 'enqueued'; runId: string; teamId: string; slotCount: number }
  | {
      status: 'skipped';
      teamId: string | null;
      reason:
        | 'no_team'
        | 'no_product'
        | 'no_coordinator'
        | 'no_slots_today'
        | 'throttled'
        | 'already_running';
    };

export interface MaybeEnqueueReplySweepDeps {
  /** DB handle — injected by tests; defaults to the shared `db`. */
  db?: Database;
  /** enqueueTeamRun hook — injected by tests to avoid touching Redis. */
  enqueueTeamRun?: (input: EnqueueTeamRunInput) => Promise<EnqueueTeamRunResult>;
  /** Inject `now` for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
}

interface ReplySlot {
  planItemId: string;
  channel: string;
  targetCount: number;
}

/**
 * Try to enqueue a reply_sweep team_run for the given userId.
 *
 * Idempotent: safe to call on every daily cron tick for every user.
 * Returns a structured result so the caller can log the skip reason
 * without parsing logs.
 */
export async function maybeEnqueueReplySweep(
  userId: string,
  deps: MaybeEnqueueReplySweepDeps = {},
): Promise<MaybeEnqueueReplySweepResult> {
  const db = deps.db ?? defaultDb;
  const enqueueTeamRun = deps.enqueueTeamRun ?? defaultEnqueueTeamRun;
  const now = deps.now ?? new Date();

  // 1. Resolve the user's team + product.
  const teamRows = await db
    .select({ id: teams.id, productId: teams.productId })
    .from(teams)
    .where(eq(teams.userId, userId))
    .limit(1);
  const team = teamRows[0];
  if (!team) {
    return { status: 'skipped', teamId: null, reason: 'no_team' };
  }
  if (!team.productId) {
    return { status: 'skipped', teamId: team.id, reason: 'no_product' };
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

  // 3. Find today's reply slots — `content_reply` plan_items in
  //    state='planned' whose scheduledAt falls in today's UTC window.
  const { start: todayStart, end: todayEnd } = todayUtcBounds(now);
  const slotRows = await db
    .select({
      id: planItems.id,
      channel: planItems.channel,
      params: planItems.params,
    })
    .from(planItems)
    .where(
      and(
        eq(planItems.userId, userId),
        eq(planItems.productId, team.productId),
        eq(planItems.kind, 'content_reply'),
        eq(planItems.state, 'planned'),
        gte(planItems.scheduledAt, todayStart),
        lt(planItems.scheduledAt, todayEnd),
      ),
    );
  const slots: ReplySlot[] = slotRows
    .map((row) => {
      const target = readTargetCount(row.params);
      if (!row.channel || target == null || target <= 0) return null;
      return {
        planItemId: row.id,
        channel: row.channel,
        targetCount: target,
      };
    })
    .filter((s): s is ReplySlot => s !== null);
  if (slots.length === 0) {
    return { status: 'skipped', teamId: team.id, reason: 'no_slots_today' };
  }

  // 4. Throttle — skip if a reply_sweep already started today.
  const recentRuns = await db
    .select({ id: teamRuns.id, startedAt: teamRuns.startedAt })
    .from(teamRuns)
    .where(
      and(
        eq(teamRuns.teamId, team.id),
        eq(teamRuns.trigger, 'reply_sweep'),
        gte(teamRuns.startedAt, todayStart),
      ),
    )
    .orderBy(desc(teamRuns.startedAt))
    .limit(1);
  if (recentRuns.length > 0) {
    return { status: 'skipped', teamId: team.id, reason: 'throttled' };
  }

  // 5. Enqueue. enqueueTeamRun handles the "one running per team"
  //    partial unique index — if a different trigger (weekly, manual,
  //    onboarding) is active, it returns alreadyRunning=true and we
  //    surface that as a skip so the cron tick doesn't treat a concurrent
  //    run as a success.
  const sweepConvId = await createAutomationConversation(team.id, 'reply_sweep');
  const result = await enqueueTeamRun({
    teamId: team.id,
    trigger: 'reply_sweep',
    goal: buildSweepGoal(slots),
    rootMemberId: coordinator.id,
    conversationId: sweepConvId,
  });

  if (result.alreadyRunning) {
    return { status: 'skipped', teamId: team.id, reason: 'already_running' };
  }

  log.info(
    `reply_sweep enqueued for user=${userId} team=${team.id} runId=${result.runId} slots=${slots.length}`,
  );
  return {
    status: 'enqueued',
    runId: result.runId,
    teamId: team.id,
    slotCount: slots.length,
  };
}

/** Pull `targetCount` out of a plan_item.params jsonb without trusting its shape. */
function readTargetCount(params: unknown): number | null {
  if (!params || typeof params !== 'object') return null;
  const value = (params as Record<string, unknown>).targetCount;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/**
 * Build the team-run goal text that the coordinator reads. Encodes
 * each slot's planItemId + channel + targetCount and the retry loop
 * shape (max 3 inner attempts), so the coordinator's
 * decision-examples reference can pattern-match this trigger and
 * dispatch correctly.
 */
function buildSweepGoal(slots: ReplySlot[]): string {
  const lines: string[] = [];
  lines.push(
    `Daily reply automation — fill ${slots.length} reply slot${slots.length === 1 ? '' : 's'} for today.`,
  );
  lines.push('');
  lines.push('Slots:');
  for (const slot of slots) {
    lines.push(
      `- planItemId=${slot.planItemId} channel=${slot.channel} targetCount=${slot.targetCount}`,
    );
  }
  lines.push('');
  lines.push('Per slot, run this loop up to 3 inner attempts:');
  lines.push(
    '  1. Call run_discovery_scan on the slot channel to surface candidate threads.',
  );
  lines.push(
    '  2. Dispatch community-manager via Task to draft replies from the queued threads.',
  );
  lines.push(
    '  3. Count drafts created today for this user/channel; if count < targetCount, retry from step 1.',
  );
  lines.push(
    '  4. After the loop ends (target hit OR scout returns 0 fresh threads twice in a row OR 3 attempts used), call update_plan_item to set state="drafted" on the slot.',
  );
  lines.push('');
  lines.push(
    'Skip threads that fail community-manager\'s three-gate quality bar — zero drafts is a valid outcome if no threads clear the bar.',
  );
  return lines.join('\n');
}
