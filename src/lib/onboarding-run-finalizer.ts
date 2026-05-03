/**
 * Phase G cleanup (migration 0016_drop_team_runs): the team_runs table is
 * gone. Phase E already stopped writing rows to it (the lead is now an
 * `agent_runs` entity, not a `team_runs` row), so this finalizer hasn't
 * had any rows to act on since Phase E shipped. We keep the function
 * exported as a no-op so its caller in `team-kickoff.ts` doesn't need to
 * change shape, and so any future reintroduction of "in-flight onboarding
 * run" semantics has a documented landing spot.
 *
 * Historical context (kept for searchability — the table is dropped now):
 *   `POST /api/onboarding/plan` used to enqueue an analyst run with
 *   `trigger='onboarding'`. The agent's job was to call
 *   `write_strategic_path` and emit StructuredOutput. Once the path was
 *   written, anything the agent did afterward was wasted compute — but
 *   the run kept `status='running'` until the worker observed the
 *   StructuredOutput. If the user clicked Commit before that flip
 *   landed, the subsequent `enqueueTeamRun({ trigger: 'kickoff' })`
 *   saw a running row and short-circuited. The finalizer pre-empted
 *   that race.
 *
 * Phase E replaced enqueueTeamRun with `dispatchLeadMessage` /
 * `spawnMemberAgentRun`, which don't have a "one running per team"
 * guard, so the original race is gone and the finalizer is a no-op.
 */

// TODO(perf-cleanup-2026-XX): re-implement onboarding finalization on
// agent_runs.status if the "one running per team" race ever re-emerges
// in practice. Today the partial unique index is gone (Phase E unified
// to dispatchLeadMessage / spawnMemberAgentRun) so this stub is honest.

export interface FinalizeOnboardingRunsResult {
  /** Always 0 post-Phase-G — kept in the shape so callers don't break. */
  finalized: number;
  /** Always empty post-Phase-G — kept in the shape so callers don't break. */
  runIds: string[];
}

/**
 * No-op stub. Kept exported so `team-kickoff.ts` doesn't need to change.
 * Returns `{ finalized: 0, runIds: [] }` unconditionally.
 */
export async function finalizePendingOnboardingRuns(
  _teamId: string,
): Promise<FinalizeOnboardingRunsResult> {
  return { finalized: 0, runIds: [] };
}
