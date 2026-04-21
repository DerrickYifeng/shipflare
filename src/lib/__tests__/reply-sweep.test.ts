/**
 * maybeEnqueueReplySweep unit tests.
 *
 * Uses the helper's explicit deps (db + enqueueTeamRun) for injection;
 * the factory never touches Redis and the in-memory store is scoped
 * per-test rather than module-wide. This sidesteps the vi.hoisted vs
 * vi.mock ordering hazards.
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
vi.mock('@/lib/db', () => ({ db: createInMemoryStore().db }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { maybeEnqueueReplySweep } from '../reply-sweep';
import type { Database } from '@/lib/db';
import { teams, teamMembers, teamRuns, threads } from '@/lib/db/schema';

interface TeamRow {
  id: string;
  userId: string;
}
interface MemberRow {
  id: string;
  teamId: string;
  agentType: string;
}
interface TeamRunRow {
  id: string;
  teamId: string;
  trigger: string;
  status: string;
  startedAt: Date;
}
interface ThreadRow {
  id: string;
  userId: string;
  discoveredAt: Date;
}

function seedTeam(
  store: InMemoryStore,
  params: {
    teamId?: string;
    userId?: string;
    withCoordinator?: boolean;
  } = {},
): { teamId: string; userId: string; coordinatorId: string } {
  const teamId = params.teamId ?? 'team-1';
  const userId = params.userId ?? 'user-1';
  const coordinatorId = `${teamId}-coord`;
  store.register<TeamRow>(teams, [{ id: teamId, userId }]);
  if (params.withCoordinator !== false) {
    store.register<MemberRow>(teamMembers, [
      { id: coordinatorId, teamId, agentType: 'coordinator' },
    ]);
  } else {
    store.register<MemberRow>(teamMembers, []);
  }
  store.register<TeamRunRow>(teamRuns, []);
  store.register<ThreadRow>(threads, []);
  return { teamId, userId, coordinatorId };
}

function seedThread(
  store: InMemoryStore,
  userId: string,
  ageMs: number,
): void {
  const list = store.get<ThreadRow>(threads);
  list.push({
    id: `thread-${list.length}`,
    userId,
    discoveredAt: new Date(Date.now() - ageMs),
  });
}

let store: InMemoryStore;
let enqueueTeamRun: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store = createInMemoryStore();
  enqueueTeamRun = vi.fn();
});

function deps() {
  return {
    db: store.db as Database,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    enqueueTeamRun: enqueueTeamRun as any,
  };
}

describe('maybeEnqueueReplySweep', () => {
  it('enqueues a reply_sweep when team + coordinator + recent thread exist', async () => {
    const { teamId, userId, coordinatorId } = seedTeam(store);
    seedThread(store, userId, 60 * 60_000); // 1h old
    enqueueTeamRun.mockResolvedValue({
      runId: 'run-1',
      traceId: 't-1',
      alreadyRunning: false,
    });

    const result = await maybeEnqueueReplySweep(userId, deps());

    expect(result).toEqual({ status: 'enqueued', runId: 'run-1', teamId });
    expect(enqueueTeamRun).toHaveBeenCalledTimes(1);
    const arg = enqueueTeamRun.mock.calls[0]![0];
    expect(arg.teamId).toBe(teamId);
    expect(arg.trigger).toBe('reply_sweep');
    expect(arg.rootMemberId).toBe(coordinatorId);
    expect(arg.goal).toContain('high-signal threads');
  });

  it('skips with no_team when the user has no team', async () => {
    store.register<TeamRow>(teams, []);
    const result = await maybeEnqueueReplySweep('orphan-user', deps());
    expect(result).toEqual({
      status: 'skipped',
      teamId: null,
      reason: 'no_team',
    });
    expect(enqueueTeamRun).not.toHaveBeenCalled();
  });

  it('skips with no_coordinator when the team has no coordinator member', async () => {
    const { teamId, userId } = seedTeam(store, { withCoordinator: false });
    seedThread(store, userId, 60 * 60_000);
    const result = await maybeEnqueueReplySweep(userId, deps());
    expect(result).toEqual({
      status: 'skipped',
      teamId,
      reason: 'no_coordinator',
    });
    expect(enqueueTeamRun).not.toHaveBeenCalled();
  });

  it('skips with throttled when a recent reply_sweep run exists', async () => {
    const { teamId, userId } = seedTeam(store);
    seedThread(store, userId, 60 * 60_000);
    store.get<TeamRunRow>(teamRuns).push({
      id: 'recent-run',
      teamId,
      trigger: 'reply_sweep',
      status: 'completed',
      startedAt: new Date(Date.now() - 60 * 60_000), // 1h ago (< 6h throttle)
    });

    const result = await maybeEnqueueReplySweep(userId, deps());

    expect(result).toEqual({
      status: 'skipped',
      teamId,
      reason: 'throttled',
    });
    expect(enqueueTeamRun).not.toHaveBeenCalled();
  });

  it('skips with empty_inbox when no thread was discovered in 24h', async () => {
    const { teamId, userId } = seedTeam(store);
    const result = await maybeEnqueueReplySweep(userId, deps());
    expect(result).toEqual({
      status: 'skipped',
      teamId,
      reason: 'empty_inbox',
    });
    expect(enqueueTeamRun).not.toHaveBeenCalled();
  });

  it('skips with already_running when enqueueTeamRun returns alreadyRunning=true', async () => {
    const { teamId, userId } = seedTeam(store);
    seedThread(store, userId, 60 * 60_000);
    enqueueTeamRun.mockResolvedValue({
      runId: 'existing-run',
      traceId: '',
      alreadyRunning: true,
    });

    const result = await maybeEnqueueReplySweep(userId, deps());
    expect(result).toEqual({
      status: 'skipped',
      teamId,
      reason: 'already_running',
    });
  });

  it('allows an enqueue when the last reply_sweep is older than the throttle window', async () => {
    const { teamId, userId } = seedTeam(store);
    seedThread(store, userId, 60 * 60_000);
    store.get<TeamRunRow>(teamRuns).push({
      id: 'old-run',
      teamId,
      trigger: 'reply_sweep',
      status: 'completed',
      startedAt: new Date(Date.now() - 7 * 60 * 60_000), // 7h ago (> 6h throttle)
    });
    enqueueTeamRun.mockResolvedValue({
      runId: 'run-2',
      traceId: 't-2',
      alreadyRunning: false,
    });

    const result = await maybeEnqueueReplySweep(userId, deps());

    expect(result).toEqual({ status: 'enqueued', runId: 'run-2', teamId });
  });
});
