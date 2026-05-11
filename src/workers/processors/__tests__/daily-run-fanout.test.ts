import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { DiscoveryScanJobData } from '@/lib/queue/types';

/**
 * Verifies the daily-run-fanout worker. After the 2026-05-06 cleanup the
 * worker dispatches via the shared `ensureDailyRunEnqueued` helper (one
 * call per eligible user) instead of building goal-text inline. The
 * automation-stop signal is gone (the manual UI trigger that drove it was
 * removed).
 */

let lastProductUserFilter: string | null = null;
let lastConvTeamFilter: string | null = null;

const fixtures = {
  channels: [
    { userId: 'u-1', platform: 'reddit' },
    { userId: 'u-1', platform: 'x' },
    { userId: 'u-2', platform: 'reddit' },
    { userId: 'u-3', platform: 'reddit' }, // no product — should skip
    { userId: 'u-4', platform: 'x' },
  ],
  products: {
    'u-1': [{ id: 'p-1', name: 'Product One' }],
    'u-2': [{ id: 'p-2', name: 'Product Two' }],
    'u-3': [],
    'u-4': [{ id: 'p-4', name: 'Product Four' }],
  } as Record<string, { id: string; name: string }[]>,
  // Map of teamId → rows returned by the kickoff-dedup lookup. Default
  // is "no kickoff today" (empty array); tests can pre-populate this
  // to simulate a same-day kickoff for a specific team.
  kickoffsToday: {} as Record<string, { id: string }[]>,
};

vi.mock('@/lib/db/schema', () => ({
  channels: { userId: 'userId', platform: 'platform' },
  products: { userId: 'userId', id: 'id', name: 'name' },
  teamConversations: {
    id: 'id',
    teamId: 'team_id',
    title: 'title',
    createdAt: 'created_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => {
    if (typeof val === 'string') {
      // Track both the product-user filter and the kickoff-team filter.
      // The kickoff query has shape eq(teamConversations.teamId, 'team-x').
      if (val.startsWith('team-')) {
        lastConvTeamFilter = val;
      } else {
        lastProductUserFilter = val;
      }
    }
    return { kind: 'eq', col, val };
  },
  and: (...clauses: unknown[]) => ({ kind: 'and', clauses }),
  gte: (col: unknown, val: unknown) => ({ kind: 'gte', col, val }),
  like: (col: unknown, val: unknown) => ({ kind: 'like', col, val }),
}));

vi.mock('@/lib/db', () => ({
  db: {
    select: (projection?: unknown) => ({
      from: (table?: unknown) => {
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
        // teamConversations kickoff-dedup read: projection {id}, table
        // is the teamConversations schema object — match on the shape
        // having teamId column attribute.
        if (
          proj &&
          'id' in proj &&
          !('name' in proj) &&
          table &&
          typeof table === 'object' &&
          'teamId' in (table as Record<string, unknown>)
        ) {
          return {
            where: () => ({
              limit: () =>
                Promise.resolve(
                  fixtures.kickoffsToday[lastConvTeamFilter ?? ''] ?? [],
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

vi.mock('@/lib/team-provisioner', () => ({
  ensureTeamExists: vi.fn(async (userId: string) => ({
    teamId: `team-${userId}`,
    memberIds: {},
    created: false,
  })),
}));

vi.mock('@/lib/team-daily-run', () => ({
  ensureDailyRunEnqueued: vi.fn(async () => ({
    fired: true,
    runId: 'msg-x',
    conversationId: 'conv-x',
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  lastProductUserFilter = null;
  lastConvTeamFilter = null;
  fixtures.kickoffsToday = {};
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
    const { ensureDailyRunEnqueued } = await import('@/lib/team-daily-run');

    await processDailyRunFanout(nonFanoutJob());

    expect(ensureDailyRunEnqueued).not.toHaveBeenCalled();
  });

  it('calls ensureDailyRunEnqueued exactly once per user with channels + product', async () => {
    const { processDailyRunFanout } = await import('../daily-run-fanout');
    const { ensureDailyRunEnqueued } = await import('@/lib/team-daily-run');

    await processDailyRunFanout(fanoutJob());

    // u-1: has channels + product → 1 dispatch
    // u-2: has channels + product → 1 dispatch
    // u-3: no product → skipped
    // u-4: has channels + product → 1 dispatch
    expect(ensureDailyRunEnqueued).toHaveBeenCalledTimes(3);

    const calls = (
      ensureDailyRunEnqueued as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    const summaries = calls.map((c) => {
      const p = c[0] as {
        userId: string;
        productId: string;
        teamId: string;
        platforms: string[];
        source?: string;
      };
      return {
        userId: p.userId,
        productId: p.productId,
        teamId: p.teamId,
        platforms: [...p.platforms].sort(),
        source: p.source,
      };
    });

    expect(summaries).toEqual(
      expect.arrayContaining([
        {
          userId: 'u-1',
          productId: 'p-1',
          teamId: 'team-u-1',
          platforms: ['reddit', 'x'],
          source: 'cron',
        },
        {
          userId: 'u-2',
          productId: 'p-2',
          teamId: 'team-u-2',
          platforms: ['reddit'],
          source: 'cron',
        },
        {
          userId: 'u-4',
          productId: 'p-4',
          teamId: 'team-u-4',
          platforms: ['x'],
          source: 'cron',
        },
      ]),
    );
  });

  it('skips users with channels but no product', async () => {
    const { processDailyRunFanout } = await import('../daily-run-fanout');
    const { ensureDailyRunEnqueued } = await import('@/lib/team-daily-run');

    await processDailyRunFanout(fanoutJob());

    const calls = (
      ensureDailyRunEnqueued as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    const userIds = calls.map((c) => (c[0] as { userId: string }).userId);
    // u-3 has a channel row but no product — must not be dispatched.
    expect(userIds).not.toContain('u-3');
  });

  it('skips users whose team already had a kickoff today (UTC)', async () => {
    // Simulate u-1's team having a kickoff row from earlier today.
    fixtures.kickoffsToday['team-u-1'] = [{ id: 'conv-kickoff-1' }];

    const { processDailyRunFanout } = await import('../daily-run-fanout');
    const { ensureDailyRunEnqueued } = await import('@/lib/team-daily-run');

    await processDailyRunFanout(fanoutJob());

    const calls = (
      ensureDailyRunEnqueued as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    const userIds = calls.map((c) => (c[0] as { userId: string }).userId);

    // u-1 was kickoff'd today → daily skipped. Other eligible users still fire.
    expect(userIds).not.toContain('u-1');
    expect(userIds).toEqual(expect.arrayContaining(['u-2', 'u-4']));
    expect(ensureDailyRunEnqueued).toHaveBeenCalledTimes(2);
  });
});
