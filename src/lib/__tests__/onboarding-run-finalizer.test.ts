/**
 * finalizePendingOnboardingRuns unit tests.
 *
 * Confirms that:
 *  - Pending/running onboarding-trigger runs flip to 'cancelled' with
 *    completedAt set.
 *  - Other triggers (kickoff, weekly, manual, …) and other teams are NOT
 *    touched.
 *  - Already-terminal rows ('completed', 'failed', 'cancelled') are NOT
 *    overwritten — the worker's natural finish wins the race.
 *  - One cancel pub/sub message fires per finalized run, on the per-run
 *    channel.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createInMemoryStore,
  drizzleMockFactory,
  type InMemoryStore,
} from '@/lib/test-utils/in-memory-db';

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return drizzleMockFactory(actual as unknown as Record<string, unknown>);
});

const publishedRaw: Array<{ channel: string; message: string }> = [];
vi.mock('@/lib/redis', () => ({
  getPubSubPublisher: () => ({
    publish: async (channel: string, message: string) => {
      publishedRaw.push({ channel, message });
      return 1;
    },
  }),
  // Phase D Task 6 added a transitive wake() import via SendMessageTool →
  // wake.ts → @/lib/queue/agent-run, which calls getBullMQConnection() at
  // module load. We never enqueue in this test (the wake call path isn't
  // exercised), but the import has to resolve.
  getBullMQConnection: () => ({}),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

const store: { current: InMemoryStore } = {
  current: createInMemoryStore(),
};
vi.mock('@/lib/db', () => ({
  get db() {
    return store.current.db;
  },
}));

import { finalizePendingOnboardingRuns } from '../onboarding-run-finalizer';
import { teamRuns } from '@/lib/db/schema';

interface TeamRunRow {
  id: string;
  teamId: string;
  trigger: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
}

function seedRun(
  s: InMemoryStore,
  row: Partial<TeamRunRow> & { id: string; teamId: string; trigger: string; status: string },
): void {
  const list = s.get<TeamRunRow>(teamRuns);
  list.push({
    startedAt: new Date(Date.now() - 30_000),
    completedAt: null,
    ...row,
  });
}

beforeEach(() => {
  store.current = createInMemoryStore();
  store.current.register<TeamRunRow>(teamRuns, []);
  publishedRaw.length = 0;
});

describe('finalizePendingOnboardingRuns', () => {
  it('returns finalized=0 when there are no in-flight onboarding runs', async () => {
    const result = await finalizePendingOnboardingRuns('team-1');
    expect(result.finalized).toBe(0);
    expect(result.runIds).toEqual([]);
    expect(publishedRaw).toEqual([]);
  });

  it('flips a single running onboarding run to cancelled and signals cancel', async () => {
    seedRun(store.current, {
      id: 'run-onboarding-1',
      teamId: 'team-1',
      trigger: 'onboarding',
      status: 'running',
    });

    const result = await finalizePendingOnboardingRuns('team-1');

    expect(result.finalized).toBe(1);
    expect(result.runIds).toEqual(['run-onboarding-1']);

    const rows = store.current.get<TeamRunRow>(teamRuns);
    expect(rows[0]!.status).toBe('cancelled');
    expect(rows[0]!.completedAt).toBeInstanceOf(Date);

    expect(publishedRaw).toHaveLength(1);
    expect(publishedRaw[0]!.channel).toContain('run-onboarding-1');
    expect(JSON.parse(publishedRaw[0]!.message).reason).toBe('kickoff-handoff');
  });

  it('also catches pending (queued-but-not-started) runs', async () => {
    seedRun(store.current, {
      id: 'run-onboarding-2',
      teamId: 'team-1',
      trigger: 'onboarding',
      status: 'pending',
    });

    const result = await finalizePendingOnboardingRuns('team-1');

    expect(result.finalized).toBe(1);
    const rows = store.current.get<TeamRunRow>(teamRuns);
    expect(rows[0]!.status).toBe('cancelled');
  });

  it('does NOT touch runs from other triggers (kickoff, weekly, manual)', async () => {
    seedRun(store.current, {
      id: 'run-kickoff',
      teamId: 'team-1',
      trigger: 'kickoff',
      status: 'running',
    });
    seedRun(store.current, {
      id: 'run-weekly',
      teamId: 'team-1',
      trigger: 'weekly',
      status: 'running',
    });

    const result = await finalizePendingOnboardingRuns('team-1');

    expect(result.finalized).toBe(0);
    const rows = store.current.get<TeamRunRow>(teamRuns);
    expect(rows.find((r) => r.id === 'run-kickoff')!.status).toBe('running');
    expect(rows.find((r) => r.id === 'run-weekly')!.status).toBe('running');
    expect(publishedRaw).toEqual([]);
  });

  it('does NOT touch onboarding runs on other teams', async () => {
    seedRun(store.current, {
      id: 'run-other-team',
      teamId: 'team-OTHER',
      trigger: 'onboarding',
      status: 'running',
    });

    const result = await finalizePendingOnboardingRuns('team-1');

    expect(result.finalized).toBe(0);
    const rows = store.current.get<TeamRunRow>(teamRuns);
    expect(rows[0]!.status).toBe('running');
  });

  it('does NOT overwrite already-terminal onboarding rows', async () => {
    seedRun(store.current, {
      id: 'run-already-completed',
      teamId: 'team-1',
      trigger: 'onboarding',
      status: 'completed',
    });
    seedRun(store.current, {
      id: 'run-already-cancelled',
      teamId: 'team-1',
      trigger: 'onboarding',
      status: 'cancelled',
    });

    const result = await finalizePendingOnboardingRuns('team-1');

    expect(result.finalized).toBe(0);
    const rows = store.current.get<TeamRunRow>(teamRuns);
    expect(rows.find((r) => r.id === 'run-already-completed')!.status).toBe(
      'completed',
    );
    expect(rows.find((r) => r.id === 'run-already-cancelled')!.status).toBe(
      'cancelled',
    );
  });

  it('finalizes multiple onboarding runs in one call (defensive — should be ≤1 normally)', async () => {
    seedRun(store.current, {
      id: 'run-A',
      teamId: 'team-1',
      trigger: 'onboarding',
      status: 'running',
    });
    seedRun(store.current, {
      id: 'run-B',
      teamId: 'team-1',
      trigger: 'onboarding',
      status: 'pending',
    });

    const result = await finalizePendingOnboardingRuns('team-1');

    expect(result.finalized).toBe(2);
    expect(result.runIds.sort()).toEqual(['run-A', 'run-B']);
    expect(publishedRaw).toHaveLength(2);
  });
});
