import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { DiscoveryScanJobData } from '@/lib/queue/types';

/**
 * Verifies the daily-run-fanout worker. Phase E Task 11: the worker now
 * dispatches via `dispatchLeadMessage` instead of `enqueueTeamRun`. The
 * lead is a regular `agent_runs` row driven by the unified agent-run
 * worker, so per-user team_members lookup + rootMemberId routing is gone.
 */

let lastProductUserFilter: string | null = null;

const fixtures = {
  channels: [
    { userId: 'u-1', platform: 'reddit' },
    { userId: 'u-1', platform: 'x' },
    { userId: 'u-2', platform: 'reddit' },
    { userId: 'u-3', platform: 'reddit' }, // no product — should skip
    { userId: 'u-4', platform: 'x' }, // automation stopped — should skip
  ],
  products: {
    'u-1': [{ id: 'p-1', name: 'Product One' }],
    'u-2': [{ id: 'p-2', name: 'Product Two' }],
    'u-3': [],
    'u-4': [{ id: 'p-4', name: 'Product Four' }],
  } as Record<string, { id: string; name: string }[]>,
};

vi.mock('@/lib/db/schema', () => ({
  channels: { userId: 'userId', platform: 'platform' },
  products: { userId: 'userId', id: 'id', name: 'name' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => {
    if (typeof val === 'string') {
      lastProductUserFilter = val;
    }
    return { col, val };
  },
}));

vi.mock('@/lib/db', () => ({
  db: {
    select: (projection?: unknown) => ({
      from: (_table: unknown) => {
        const proj = projection as Record<string, unknown> | undefined;
        // channels read: { userId, platform }
        if (proj && 'platform' in proj && 'userId' in proj) {
          return Promise.resolve(fixtures.channels);
        }
        // products read: { id, name } with .where().limit()
        if (proj && 'id' in proj && 'name' in proj) {
          return {
            where: () => ({
              limit: () =>
                Promise.resolve(
                  fixtures.products[lastProductUserFilter ?? ''] ?? [],
                ),
            }),
          };
        }
        return {
          where: () => ({ limit: () => Promise.resolve([]) }),
        };
      },
    }),
  },
}));

const stopFlags: Record<string, boolean> = {};
vi.mock('@/lib/automation-stop', () => ({
  isStopRequested: vi.fn(async (uid: string) => stopFlags[uid] === true),
}));

vi.mock('@/lib/team-provisioner', () => ({
  ensureTeamExists: vi.fn(async (userId: string) => ({
    teamId: `team-${userId}`,
    memberIds: {},
    created: false,
  })),
}));

vi.mock('@/lib/team-rolling-conversation', () => ({
  resolveRollingConversation: vi.fn(
    async (teamId: string, title: string) => `conv-${teamId}-${title}`,
  ),
}));

vi.mock('@/lib/team/dispatch-lead-message', () => ({
  dispatchLeadMessage: vi.fn(async () => ({
    runId: 'msg-x',
    traceId: 'lead-x',
    alreadyRunning: false,
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  lastProductUserFilter = null;
  for (const k of Object.keys(stopFlags)) delete stopFlags[k];
});

function fanoutJob(): Job<DiscoveryScanJobData> {
  return {
    id: 'job-cron-fanout-1',
    data: {
      kind: 'fanout',
      schemaVersion: 1,
      traceId: 'trace-cron-fanout',
    },
  } as unknown as Job<DiscoveryScanJobData>;
}

function nonFanoutJob(): Job<DiscoveryScanJobData> {
  return {
    id: 'job-not-fanout',
    data: {
      kind: 'user',
      schemaVersion: 1,
      traceId: 'trace-user',
      userId: 'u-1',
      productId: 'p-1',
      platform: 'x',
      scanRunId: 'manual-1',
      trigger: 'manual',
    } as unknown as DiscoveryScanJobData,
  } as unknown as Job<DiscoveryScanJobData>;
}

describe('processDailyRunFanout', () => {
  it('refuses non-fanout jobs without dispatching anything', async () => {
    const { processDailyRunFanout } = await import('../daily-run-fanout');
    const { dispatchLeadMessage } = await import(
      '@/lib/team/dispatch-lead-message'
    );

    await processDailyRunFanout(nonFanoutJob());

    expect(dispatchLeadMessage).not.toHaveBeenCalled();
  });

  it('dispatches exactly one lead message per user with channels + product', async () => {
    const { processDailyRunFanout } = await import('../daily-run-fanout');
    const { dispatchLeadMessage } = await import(
      '@/lib/team/dispatch-lead-message'
    );
    const { resolveRollingConversation } = await import(
      '@/lib/team-rolling-conversation'
    );

    await processDailyRunFanout(fanoutJob());

    // u-1: has channels + product → 1 dispatch
    // u-2: has channels + product → 1 dispatch
    // u-3: no product → skipped
    // u-4: has channels + product (no stop flag set) → 1 dispatch
    expect(dispatchLeadMessage).toHaveBeenCalledTimes(3);

    const calls = (
      dispatchLeadMessage as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    const summaries = calls.map((c) => {
      const p = c[0] as {
        teamId: string;
        trigger: string;
        conversationId: string;
      };
      return {
        teamId: p.teamId,
        trigger: p.trigger,
        conversationId: p.conversationId,
      };
    });

    expect(summaries).toEqual(
      expect.arrayContaining([
        {
          teamId: 'team-u-1',
          trigger: 'daily',
          conversationId: 'conv-team-u-1-Discovery',
        },
        {
          teamId: 'team-u-2',
          trigger: 'daily',
          conversationId: 'conv-team-u-2-Discovery',
        },
        {
          teamId: 'team-u-4',
          trigger: 'daily',
          conversationId: 'conv-team-u-4-Discovery',
        },
      ]),
    );

    // Conversation lookup uses the 'Discovery' rolling title.
    const convCalls = (
      resolveRollingConversation as unknown as {
        mock: { calls: unknown[][] };
      }
    ).mock.calls;
    expect(convCalls.length).toBe(3);
    for (const call of convCalls) {
      expect(call[1]).toBe('Discovery');
    }
  });

  it('skips users with isStopRequested=true', async () => {
    stopFlags['u-1'] = true;

    const { processDailyRunFanout } = await import('../daily-run-fanout');
    const { dispatchLeadMessage } = await import(
      '@/lib/team/dispatch-lead-message'
    );

    await processDailyRunFanout(fanoutJob());

    // u-1 stopped, u-3 no product → only u-2 + u-4 get dispatched
    expect(dispatchLeadMessage).toHaveBeenCalledTimes(2);
    const calls = (
      dispatchLeadMessage as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    const teamIds = calls.map(
      (c) => (c[0] as { teamId: string }).teamId,
    );
    expect(teamIds).not.toContain('team-u-1');
    expect(teamIds).toEqual(expect.arrayContaining(['team-u-2', 'team-u-4']));
  });

  it('skips users with channels but no product', async () => {
    const { processDailyRunFanout } = await import('../daily-run-fanout');
    const { dispatchLeadMessage } = await import(
      '@/lib/team/dispatch-lead-message'
    );

    await processDailyRunFanout(fanoutJob());

    const calls = (
      dispatchLeadMessage as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    const teamIds = calls.map(
      (c) => (c[0] as { teamId: string }).teamId,
    );
    // u-3 has a channel row but no product — must not be dispatched.
    expect(teamIds).not.toContain('team-u-3');
  });
});
