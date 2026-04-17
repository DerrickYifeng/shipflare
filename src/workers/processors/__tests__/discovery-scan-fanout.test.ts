import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { DiscoveryScanJobData } from '@/lib/queue/types';

/**
 * Channels selected by the fanout branch. The processor runs
 * `db.select({...}).from(channels)` first, then `db.select({...}).from(products).where().limit()`
 * per user. We route each call by `from` target and keep state small.
 */
const fixtures = {
  channels: [
    { userId: 'u-1', platform: 'reddit' },
    { userId: 'u-1', platform: 'x' },
    { userId: 'u-2', platform: 'reddit' },
    { userId: 'u-3', platform: 'reddit' }, // no product — should skip
  ],
  products: {
    'u-1': [{ id: 'p-1' }],
    'u-2': [{ id: 'p-2' }],
    'u-3': [], // missing product
  } as Record<string, { id: string }[]>,
};

let lastProductUserFilter: string | null = null;

vi.mock('@/lib/db/schema', () => ({
  channels: { userId: 'userId', platform: 'platform' },
  products: { userId: 'userId', id: 'id' },
  discoveryConfigs: { userId: 'userId' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => {
    // Capture the userId filter so the products select returns the right row.
    if (typeof val === 'string') lastProductUserFilter = val;
    return { col, val };
  },
}));

vi.mock('@/lib/db', () => ({
  db: {
    select: (projection?: unknown) => ({
      from: (table: unknown) => {
        // Fanout channels read: shape `{userId, platform}` projection.
        if (
          projection &&
          typeof projection === 'object' &&
          'platform' in (projection as Record<string, unknown>)
        ) {
          return Promise.resolve(fixtures.channels);
        }
        // Products lookup: `.where().limit()` chain.
        if (
          projection &&
          typeof projection === 'object' &&
          'id' in (projection as Record<string, unknown>) &&
          !('platform' in (projection as Record<string, unknown>))
        ) {
          return {
            where: () => ({
              limit: () =>
                Promise.resolve(
                  fixtures.products[lastProductUserFilter ?? ''] ?? [],
                ),
            }),
          };
        }
        // Default unused branches.
        void table;
        return {
          where: () => ({ limit: () => Promise.resolve([]) }),
        };
      },
    }),
  },
}));

vi.mock('@/lib/queue', () => ({
  enqueueDiscoveryScan: vi.fn(),
  enqueueSearchSource: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));

vi.mock('@/lib/automation-stop', () => ({
  isStopRequested: vi.fn(async () => false),
}));

vi.mock('@/lib/platform-config', () => ({
  getPlatformConfig: () => ({ defaultSources: ['r/SaaS'] }),
  isPlatformAvailable: (p: string) => p === 'reddit' || p === 'x',
}));

vi.mock('@/lib/pipeline-events', () => ({ recordPipelineEvent: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  lastProductUserFilter = null;
});

function fanoutJob(): Job<DiscoveryScanJobData> {
  return {
    id: 'job-fanout-1',
    data: {
      kind: 'fanout',
      schemaVersion: 1,
      traceId: 'cron-discovery-scan-fanout',
    },
  } as unknown as Job<DiscoveryScanJobData>;
}

describe('processDiscoveryScan — fanout branch', () => {
  it('enqueues one per-user scan per (userId, available-platform) pair', async () => {
    const { processDiscoveryScan } = await import('../discovery-scan');
    const { enqueueDiscoveryScan } = await import('@/lib/queue');

    await processDiscoveryScan(fanoutJob());

    // u-1 has reddit + x (both available, both have product-1) = 2 jobs
    // u-2 has reddit (available, product-2) = 1 job
    // u-3 has reddit but no product = skipped
    expect(enqueueDiscoveryScan).toHaveBeenCalledTimes(3);

    const calls = (
      enqueueDiscoveryScan as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    const summaries = calls.map((c) => {
      const p = c[0] as { userId: string; platform: string; trigger: string };
      return { userId: p.userId, platform: p.platform, trigger: p.trigger };
    });

    expect(summaries).toEqual(
      expect.arrayContaining([
        { userId: 'u-1', platform: 'reddit', trigger: 'cron' },
        { userId: 'u-1', platform: 'x', trigger: 'cron' },
        { userId: 'u-2', platform: 'reddit', trigger: 'cron' },
      ]),
    );
    expect(summaries).not.toContainEqual(
      expect.objectContaining({ userId: 'u-3' }),
    );

    // scanRunId should be `cron-<ts>-<rand>` on each.
    for (const call of calls) {
      const payload = call[0] as { scanRunId: string };
      expect(payload.scanRunId).toMatch(/^cron-\d+-[a-f0-9]{8}$/);
    }
  });

  it('skips users who have opted into automation-stop', async () => {
    const { isStopRequested } = await import('@/lib/automation-stop');
    (
      isStopRequested as unknown as {
        mockImplementation: (fn: (u: string) => Promise<boolean>) => void;
      }
    ).mockImplementation(async (uid: string) => uid === 'u-1');

    const { processDiscoveryScan } = await import('../discovery-scan');
    const { enqueueDiscoveryScan } = await import('@/lib/queue');

    await processDiscoveryScan(fanoutJob());

    // u-1 stopped; u-2 reddit = 1; u-3 no product.
    expect(enqueueDiscoveryScan).toHaveBeenCalledTimes(1);
    const payload = (
      enqueueDiscoveryScan as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0][0] as { userId: string };
    expect(payload.userId).toBe('u-2');
  });
});
