import { describe, it, expect, vi, beforeEach } from 'vitest';

let channelRows: Array<{ userId: string }> = [];
let productRows: Array<{ userId: string }> = [];
const enqueueCalls: Array<{ kind: 'user'; userId: string }> = [];

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: (table: { _label?: string }) => {
        if (table._label === 'products') return Promise.resolve(productRows);
        return Promise.resolve(channelRows);
      },
    }),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  channels: { _label: 'channels', userId: 'channels.userId' },
  products: { _label: 'products', userId: 'products.userId' },
}));

vi.mock('@/lib/queue', () => ({
  enqueueGrowthRollup: vi.fn(async (data: { kind: 'user'; userId: string }) => {
    enqueueCalls.push(data);
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  loggerForJob: (l: unknown) => l,
}));

import { processGrowthRollupFanout } from '../growth-rollup-fanout';

function makeJob(kind: 'fanout' | 'user', userId?: string) {
  const data =
    kind === 'fanout'
      ? { kind: 'fanout' as const, schemaVersion: 1 as const }
      : { kind: 'user' as const, userId: userId ?? 'u', schemaVersion: 1 as const };
  return { id: 'job-1', data } as unknown as Parameters<typeof processGrowthRollupFanout>[0];
}

beforeEach(() => {
  channelRows = [];
  productRows = [];
  enqueueCalls.length = 0;
});

describe('processGrowthRollupFanout', () => {
  it('ignores non-fanout payloads', async () => {
    await processGrowthRollupFanout(makeJob('user', 'u1'));
    expect(enqueueCalls).toHaveLength(0);
  });

  it('enqueues one job per distinct userId', async () => {
    productRows = [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }];
    await processGrowthRollupFanout(makeJob('fanout'));
    expect(enqueueCalls).toEqual([
      { kind: 'user', userId: 'u1' },
      { kind: 'user', userId: 'u2' },
      { kind: 'user', userId: 'u3' },
    ]);
  });

  it('dedupes users appearing in both products and channels', async () => {
    productRows = [{ userId: 'u1' }, { userId: 'u2' }];
    channelRows = [{ userId: 'u1' }]; // u1 also has an X channel
    await processGrowthRollupFanout(makeJob('fanout'));
    expect(enqueueCalls).toHaveLength(2);
    expect(enqueueCalls.map((c) => c.userId).sort()).toEqual(['u1', 'u2']);
  });

  it('reddit-only users (product but no channels) are still enqueued', async () => {
    productRows = [{ userId: 'reddit-only-user' }];
    channelRows = []; // no channels at all
    await processGrowthRollupFanout(makeJob('fanout'));
    expect(enqueueCalls).toEqual([{ kind: 'user', userId: 'reddit-only-user' }]);
  });
});
