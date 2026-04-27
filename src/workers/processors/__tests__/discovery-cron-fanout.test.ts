import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { DiscoveryScanJobData } from '@/lib/queue/types';

/**
 * Verifies the discovery-cron-fanout worker. Mirrors the shape used by
 * `discovery-scan-fanout.test.ts` but exercises the team-run-based fanout
 * shipped in T12 of the unified discovery pipeline plan.
 */

let lastProductUserFilter: string | null = null;
let lastTeamMembersFilter: string | null = null;

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
  teamMembers: {
    'team-u-1': [
      { id: 'm-coord-1', agentType: 'coordinator' },
      { id: 'm-other-1', agentType: 'community-manager' },
    ],
    'team-u-2': [{ id: 'm-coord-2', agentType: 'coordinator' }],
    'team-u-4': [{ id: 'm-coord-4', agentType: 'coordinator' }],
  } as Record<string, { id: string; agentType: string }[]>,
};

vi.mock('@/lib/db/schema', () => ({
  channels: { userId: 'userId', platform: 'platform' },
  products: { userId: 'userId', id: 'id', name: 'name' },
  teamMembers: { id: 'id', teamId: 'teamId', agentType: 'agentType' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => {
    if (typeof val === 'string') {
      // Heuristic: products.userId vs teamMembers.teamId — both are strings.
      // Last write wins; the processor reads products immediately before the
      // teamMembers select per user, so stash both targets and let the db mock
      // route by projection shape.
      if (val.startsWith('team-')) lastTeamMembersFilter = val;
      else lastProductUserFilter = val;
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
        // teamMembers read: { id, agentType } with .where()
        if (proj && 'id' in proj && 'agentType' in proj) {
          return {
            where: () =>
              Promise.resolve(
                fixtures.teamMembers[lastTeamMembersFilter ?? ''] ?? [],
              ),
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

vi.mock('@/lib/queue/team-run', () => ({
  enqueueTeamRun: vi.fn(async () => ({ runId: 'run-x', jobId: 'job-x' })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  lastProductUserFilter = null;
  lastTeamMembersFilter = null;
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

describe('processDiscoveryCronFanout', () => {
  it('refuses non-fanout jobs without enqueueing anything', async () => {
    const { processDiscoveryCronFanout } = await import(
      '../discovery-cron-fanout'
    );
    const { enqueueTeamRun } = await import('@/lib/queue/team-run');

    await processDiscoveryCronFanout(nonFanoutJob());

    expect(enqueueTeamRun).not.toHaveBeenCalled();
  });

  it('enqueues exactly one team-run per user with channels + product', async () => {
    const { processDiscoveryCronFanout } = await import(
      '../discovery-cron-fanout'
    );
    const { enqueueTeamRun } = await import('@/lib/queue/team-run');
    const { resolveRollingConversation } = await import(
      '@/lib/team-rolling-conversation'
    );

    await processDiscoveryCronFanout(fanoutJob());

    // u-1: has channels + product → 1 run
    // u-2: has channels + product → 1 run
    // u-3: no product → skipped
    // u-4: has channels + product (no stop flag set) → 1 run
    expect(enqueueTeamRun).toHaveBeenCalledTimes(3);

    const calls = (
      enqueueTeamRun as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    const summaries = calls.map((c) => {
      const p = c[0] as {
        teamId: string;
        trigger: string;
        rootMemberId: string;
        conversationId: string;
      };
      return {
        teamId: p.teamId,
        trigger: p.trigger,
        rootMemberId: p.rootMemberId,
        conversationId: p.conversationId,
      };
    });

    expect(summaries).toEqual(
      expect.arrayContaining([
        {
          teamId: 'team-u-1',
          trigger: 'discovery_cron',
          rootMemberId: 'm-coord-1',
          conversationId: 'conv-team-u-1-Discovery',
        },
        {
          teamId: 'team-u-2',
          trigger: 'discovery_cron',
          rootMemberId: 'm-coord-2',
          conversationId: 'conv-team-u-2-Discovery',
        },
        {
          teamId: 'team-u-4',
          trigger: 'discovery_cron',
          rootMemberId: 'm-coord-4',
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

    const { processDiscoveryCronFanout } = await import(
      '../discovery-cron-fanout'
    );
    const { enqueueTeamRun } = await import('@/lib/queue/team-run');

    await processDiscoveryCronFanout(fanoutJob());

    // u-1 stopped, u-3 no product → only u-2 + u-4 get runs
    expect(enqueueTeamRun).toHaveBeenCalledTimes(2);
    const calls = (
      enqueueTeamRun as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    const teamIds = calls.map(
      (c) => (c[0] as { teamId: string }).teamId,
    );
    expect(teamIds).not.toContain('team-u-1');
    expect(teamIds).toEqual(expect.arrayContaining(['team-u-2', 'team-u-4']));
  });

  it('skips users with channels but no product', async () => {
    const { processDiscoveryCronFanout } = await import(
      '../discovery-cron-fanout'
    );
    const { enqueueTeamRun } = await import('@/lib/queue/team-run');

    await processDiscoveryCronFanout(fanoutJob());

    const calls = (
      enqueueTeamRun as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    const teamIds = calls.map(
      (c) => (c[0] as { teamId: string }).teamId,
    );
    // u-3 has a channel row but no product — must not be enqueued.
    expect(teamIds).not.toContain('team-u-3');
  });
});
