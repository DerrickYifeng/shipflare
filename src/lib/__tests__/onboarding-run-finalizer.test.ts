/**
 * Phase G cleanup (migration 0016_drop_team_runs): the underlying
 * team_runs table is gone and `finalizePendingOnboardingRuns` is now a
 * no-op stub. This test confirms the stub returns the documented
 * { finalized: 0, runIds: [] } shape so callers in `team-kickoff.ts`
 * keep working. The original behavioural tests (cancellation, pub/sub
 * fan-out, status-guard correctness) were retired alongside the table
 * — see git history for `onboarding-run-finalizer.test.ts` if you need
 * the legacy fixtures for the future cost-tracking restoration.
 */
import { describe, it, expect } from 'vitest';
import { finalizePendingOnboardingRuns } from '../onboarding-run-finalizer';

describe('finalizePendingOnboardingRuns (Phase G stub)', () => {
  it('returns finalized=0 and an empty runIds list', async () => {
    const result = await finalizePendingOnboardingRuns('team-1');
    expect(result.finalized).toBe(0);
    expect(result.runIds).toEqual([]);
  });

  it('is a pure no-op — repeated calls produce the same shape', async () => {
    const a = await finalizePendingOnboardingRuns('team-1');
    const b = await finalizePendingOnboardingRuns('team-2');
    expect(a).toEqual({ finalized: 0, runIds: [] });
    expect(b).toEqual({ finalized: 0, runIds: [] });
  });
});
