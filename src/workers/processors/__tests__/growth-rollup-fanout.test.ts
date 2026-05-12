import { describe, it, expect, vi, beforeEach } from 'vitest';

let channelRows: Array<{ userId: string }> = [];
const enqueueCalls: Array<{ kind: 'user'; userId: string }> = [];

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => Promise.resolve(channelRows),
    }),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  channels: { userId: 'channels.userId' },
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
  enqueueCalls.length = 0;
});

describe('processGrowthRollupFanout', () => {
  it('ignores non-fanout payloads', async () => {
    await processGrowthRollupFanout(makeJob('user', 'u1'));
    expect(enqueueCalls).toHaveLength(0);
  });

  it('enqueues one job per distinct userId', async () => {
    channelRows = [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }];
    await processGrowthRollupFanout(makeJob('fanout'));
    expect(enqueueCalls).toEqual([
      { kind: 'user', userId: 'u1' },
      { kind: 'user', userId: 'u2' },
      { kind: 'user', userId: 'u3' },
    ]);
  });

  it('dedupes multiple channels for the same userId', async () => {
    channelRows = [
      { userId: 'u1' },
      { userId: 'u1' }, // u1 has both X and Reddit
      { userId: 'u2' },
    ];
    await processGrowthRollupFanout(makeJob('fanout'));
    expect(enqueueCalls).toHaveLength(2);
    expect(enqueueCalls.map((c) => c.userId).sort()).toEqual(['u1', 'u2']);
  });
});
