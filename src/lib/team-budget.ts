// Weekly budget tracking for AI teams.
//
// Phase G Day 2. Each team has a weekly USD budget stored on
// `teams.config.weeklyBudgetUsd` (defaults to $5). Current spend is
// computed as the SUM of `team_runs.total_cost_usd` for runs whose
// `started_at` is on or after the current week's Monday 00:00 UTC.
//
// The budget check is consumed in two places:
//   1. The team-run worker — at run completion it records spend +
//      fires a 90%-threshold warning email (dedupe per week per team).
//   2. The `Task` tool — at spawn time it refuses to start a new
//      subagent when the team has exhausted its budget, returning an
//      is_error tool_result the parent can read and react to.
//
// Budget "reset" is implicit: the SUM's WHERE clause always uses
// `started_at >= monday(now())`, so as soon as the clock rolls into a
// new week the existing-runs contribution drops to zero.

import { and, gte, eq, sql } from 'drizzle-orm';
import { db as defaultDb, type Database } from '@/lib/db';
import { teams, teamRuns } from '@/lib/db/schema';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:team-budget');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default weekly budget applied when `teams.config.weeklyBudgetUsd` is
 * absent. Kept at $5 per spec §11 Phase G.
 */
export const DEFAULT_WEEKLY_BUDGET_USD = 5;

/**
 * Feature flag: when false, budget checks are bypassed entirely. Defaults
 * to ON — ops can set `SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE=false` to disable
 * the Task-tool auto-pause without redeploying.
 */
export function isAutoBudgetPauseEnabled(): boolean {
  const raw = (process.env.SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE ?? '').trim();
  if (raw === '') return true; // default ON
  return raw.toLowerCase() !== 'false' && raw !== '0';
}

// ---------------------------------------------------------------------------
// Week boundary
// ---------------------------------------------------------------------------

/**
 * Monday 00:00 UTC of the current week (or the week containing `now`).
 * Spec §11 Phase G is explicit: reset on UTC Monday, always.
 */
export function weekStartUtc(now: Date = new Date()): Date {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  // getUTCDay: Sun=0, Mon=1, ..., Sat=6. We want to move back to Monday.
  const dayOffset = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - dayOffset);
  return start;
}

// ---------------------------------------------------------------------------
// Budget lookup
// ---------------------------------------------------------------------------

export interface TeamBudgetSnapshot {
  teamId: string;
  /** Configured weekly budget in USD. */
  weeklyBudgetUsd: number;
  /** Spend so far in the current UTC-week (monday → now). */
  spentUsd: number;
  /** spent / budget. 0 → 1+ (may exceed 1 when overage is already booked). */
  utilization: number;
  /** True when spent ≥ budget. */
  exhausted: boolean;
  /** True when spent ≥ 90% of budget (warning threshold). */
  at90Percent: boolean;
}

/**
 * Compute the current week's budget snapshot for one team. Reads
 * `teams.config.weeklyBudgetUsd` (defaulting to DEFAULT_WEEKLY_BUDGET_USD)
 * and sums `team_runs.total_cost_usd` since the current Monday 00:00 UTC.
 *
 * Runs regardless of status — completed, running, and failed runs all
 * contribute when they carry a cost. That's intentional: a run that
 * crashed after 3 turns of spend still ate budget and we don't want the
 * Task tool to look cheap right after a failure.
 */
export async function getTeamBudgetSnapshot(
  teamId: string,
  db: Database = defaultDb,
  now: Date = new Date(),
): Promise<TeamBudgetSnapshot> {
  const [teamRow] = await db
    .select({ config: teams.config })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);

  const config = (teamRow?.config ?? {}) as {
    weeklyBudgetUsd?: number;
  };
  const weeklyBudgetUsd =
    typeof config.weeklyBudgetUsd === 'number' && config.weeklyBudgetUsd > 0
      ? config.weeklyBudgetUsd
      : DEFAULT_WEEKLY_BUDGET_USD;

  const monday = weekStartUtc(now);

  const [spendRow] = await db
    .select({
      sum: sql<string>`coalesce(sum(${teamRuns.totalCostUsd}), 0)`.as('sum'),
    })
    .from(teamRuns)
    .where(
      and(eq(teamRuns.teamId, teamId), gte(teamRuns.startedAt, monday)),
    );

  const spentUsd = spendRow ? Number(spendRow.sum) : 0;
  const utilization = weeklyBudgetUsd > 0 ? spentUsd / weeklyBudgetUsd : 0;

  return {
    teamId,
    weeklyBudgetUsd,
    spentUsd,
    utilization,
    exhausted: spentUsd >= weeklyBudgetUsd,
    at90Percent: utilization >= 0.9,
  };
}

/**
 * Convenience wrapper used by the Task tool. Returns true when the team
 * has ANY remaining budget (spent < budget). When the feature flag is
 * disabled via env, always returns true. Errors are logged and treated
 * as "budget available" so a transient DB failure does NOT block the
 * coordinator mid-plan.
 */
export async function teamHasBudgetRemaining(
  teamId: string,
  db: Database = defaultDb,
): Promise<boolean> {
  if (!isAutoBudgetPauseEnabled()) return true;
  try {
    const snap = await getTeamBudgetSnapshot(teamId, db);
    return !snap.exhausted;
  } catch (err) {
    log.warn(
      `teamHasBudgetRemaining check failed for team=${teamId}; fail-open. ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
}

// ---------------------------------------------------------------------------
// 90% warning (spec §11 Phase G Day 2)
// ---------------------------------------------------------------------------

/**
 * Pluggable "send warning" sink. Production ships with a structured-log
 * stub because the repo has no email provider wired yet; when SES/Resend
 * lands, the sink is a one-line swap. Tests inject a mock sink to assert
 * the call happened without blocking on Redis.
 */
export type BudgetWarningSink = (input: {
  teamId: string;
  spentUsd: number;
  weeklyBudgetUsd: number;
  utilization: number;
}) => Promise<void>;

const defaultSink: BudgetWarningSink = async (input) => {
  // Stub email path — observability log only. Swap for real email when
  // infra lands. Tag `observability:budget-90pct` is stable for grep.
  log.warn(
    `observability:budget-90pct team=${input.teamId} spent=$${input.spentUsd.toFixed(
      4,
    )} budget=$${input.weeklyBudgetUsd.toFixed(2)} utilization=${(
      input.utilization * 100
    ).toFixed(1)}%`,
  );
};

/**
 * Pluggable dedupe gate. `true` means "first time this week for this team;
 * go ahead and send". `false` means "already warned; skip". Production
 * uses a Redis SETNX; tests inject an in-memory gate.
 */
export type BudgetWarningDedupe = (
  teamId: string,
  weekStart: Date,
) => Promise<boolean>;

const defaultDedupe: BudgetWarningDedupe = async (teamId, weekStart) => {
  // Dynamic import so unit tests that don't touch Redis don't pay the
  // connection cost just importing this module.
  const { getKeyValueClient } = await import('@/lib/redis');
  const client = getKeyValueClient();
  const key = `budget-warn:${teamId}:${weekStart.toISOString().slice(0, 10)}`;
  // SETNX returns 1 if set, 0 if already exists. Expire after 14 days so
  // stale keys don't accumulate.
  const set = await client.set(key, '1', 'EX', 14 * 24 * 60 * 60, 'NX');
  return set === 'OK';
};

/**
 * Check the post-run snapshot and emit the 90%-budget warning if we've
 * crossed the threshold AND haven't already warned this (teamId, week).
 * Safe to call after every run completion.
 */
export async function maybeEmitBudgetWarning(
  teamId: string,
  db: Database = defaultDb,
  sink: BudgetWarningSink = defaultSink,
  dedupe: BudgetWarningDedupe = defaultDedupe,
  now: Date = new Date(),
): Promise<void> {
  let snap: TeamBudgetSnapshot;
  try {
    snap = await getTeamBudgetSnapshot(teamId, db, now);
  } catch (err) {
    log.warn(
      `maybeEmitBudgetWarning snapshot failed team=${teamId}; skipping warning. ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (!snap.at90Percent) return;

  const weekStart = weekStartUtc(now);
  try {
    const firstTimeThisWeek = await dedupe(teamId, weekStart);
    if (!firstTimeThisWeek) return;
  } catch (err) {
    log.warn(
      `maybeEmitBudgetWarning dedupe failed team=${teamId}; emitting anyway. ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    await sink({
      teamId,
      spentUsd: snap.spentUsd,
      weeklyBudgetUsd: snap.weeklyBudgetUsd,
      utilization: snap.utilization,
    });
  } catch (err) {
    log.warn(
      `maybeEmitBudgetWarning sink failed team=${teamId}. ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
