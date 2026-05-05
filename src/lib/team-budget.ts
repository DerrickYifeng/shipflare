// Weekly budget tracking for AI teams.
//
// Phase G cleanup (migration 0016_drop_team_runs): the underlying data
// source — `team_runs.total_cost_usd` — is gone. Phase E stopped writing
// team_runs rows when it unified the runtime under agent_runs, so this
// helper has been silently broken (returning stale or empty data) since
// Phase E shipped. Stubbing to "no spend, never exhausted" makes the
// behavior honest about what production was already doing in practice.
//
// TODO(perf-cleanup-2026-XX): re-implement cost tracking on top of
// `agent_runs.totalTokens × model rate`. Until then, all teams are
// reported as having $0 spent and unlimited remaining budget. The
// `Task` tool's auto-pause guard never trips, the team-page budget
// snapshot shows $0/$50, and the 90% warning never fires.

import { db as defaultDb, type Database } from '@/lib/db';
import { teams } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:team-budget');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default weekly budget applied when `teams.config.weeklyBudgetUsd` is
 * absent. Temporarily raised to $50 from the spec §11 Phase G baseline
 * of $5 to avoid auto-pausing during the Discovery v3 rollout.
 */
export const DEFAULT_WEEKLY_BUDGET_USD = 50;

/**
 * Feature flag: when false, budget checks are bypassed entirely. Defaults
 * to ON — ops can set `SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE=false` to disable
 * the Task-tool auto-pause without redeploying.
 *
 * Post-Phase-G: the flag still threads through `teamHasBudgetRemaining`
 * for forward-compat; the stub returns `true` regardless because the
 * cost tracking that fed the check is dropped.
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
 * Spec §11 Phase G is explicit: reset on UTC Monday, always. Kept exported
 * because the stubbed snapshot still surfaces the week start in case a
 * future implementation wants to plumb it through.
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
// Budget snapshot
// ---------------------------------------------------------------------------

export interface TeamBudgetSnapshot {
  teamId: string;
  /** Configured weekly budget in USD. */
  weeklyBudgetUsd: number;
  /** Spend so far in the current UTC-week. Always 0 post-Phase-G stub. */
  spentUsd: number;
  /** spent / budget. Always 0 post-Phase-G stub. */
  utilization: number;
  /** True when spent ≥ budget. Always false post-Phase-G stub. */
  exhausted: boolean;
  /** True when spent ≥ 90% of budget. Always false post-Phase-G stub. */
  at90Percent: boolean;
}

/**
 * Compute the current week's budget snapshot for one team.
 *
 * Post-Phase-G stub: still reads `teams.config.weeklyBudgetUsd` so the
 * UI can show the configured budget; spend always reports 0 because the
 * data source (team_runs.total_cost_usd) is dropped. See module header
 * for the future cleanup that will restore real cost tracking.
 */
export async function getTeamBudgetSnapshot(
  teamId: string,
  db: Database = defaultDb,
  _now: Date = new Date(),
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

  return {
    teamId,
    weeklyBudgetUsd,
    spentUsd: 0,
    utilization: 0,
    exhausted: false,
    at90Percent: false,
  };
}

/**
 * Convenience wrapper used by the Task tool. Always returns true
 * post-Phase-G because the cost tracking that feeds it is dropped. Kept
 * exported so `AgentTool` doesn't need to change shape.
 */
export async function teamHasBudgetRemaining(
  _teamId: string,
  _db: Database = defaultDb,
): Promise<boolean> {
  // Stub: budget enforcement is dormant until cost tracking is rebuilt
  // on agent_runs.totalTokens. See module header.
  return true;
}

// ---------------------------------------------------------------------------
// 90% warning (spec §11 Phase G Day 2)
// ---------------------------------------------------------------------------

/**
 * Pluggable "send warning" sink. Kept exported for forward-compat with
 * the future cost-tracking restoration; today the post-Phase-G stub
 * never invokes it.
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
 * Pluggable dedupe gate. Kept exported for forward-compat with the
 * future cost-tracking restoration; the post-Phase-G stub never invokes
 * it because no warnings ever cross the 90% threshold (spend is 0).
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
 * Post-Phase-G stub: the snapshot always reports 0 spend, so the 90%
 * threshold is never crossed and the sink is never called. Kept
 * exported (and exercising the snapshot read so `teamId` validation
 * still happens) so callers in the team-run completion path don't
 * need to change.
 */
export async function maybeEmitBudgetWarning(
  teamId: string,
  db: Database = defaultDb,
  _sink: BudgetWarningSink = defaultSink,
  _dedupe: BudgetWarningDedupe = defaultDedupe,
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
  // Unreachable in the stub (at90Percent is always false), but kept
  // for type-narrowing parity with the original implementation.
}
