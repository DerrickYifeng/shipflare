import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

type Seed = {
  threadCounts: Record<string, number>;
  draftCounts: Record<string, number>;
  postCounts: Record<string, number>;
  replyCounts: Record<string, number>;
  pendingCounts: Record<string, number>;
  approved: Record<string, number>;
  skipped: Record<string, number>;
  lastPostAt: Record<string, Date | null>;
};

let seed: Seed = emptySeed();
const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];

function emptySeed(): Seed {
  return {
    threadCounts: {},
    draftCounts: {},
    postCounts: {},
    replyCounts: {},
    pendingCounts: {},
    approved: {},
    skipped: {},
    lastPostAt: {},
  };
}

vi.mock('@/workers/processors/lib/growth-counts', () => ({
  WEEK_MS: 7 * 24 * 60 * 60 * 1000,
  countThreads: vi.fn(async (_uid: string, platform: string) => seed.threadCounts[platform] ?? 0),
  countDrafts: vi.fn(async (_uid: string, platform: string) => seed.draftCounts[platform] ?? 0),
  countPosts: vi.fn(async (_uid: string, platform: string) => seed.postCounts[platform] ?? 0),
  countReplies: vi.fn(async (_uid: string, platform: string) => seed.replyCounts[platform] ?? 0),
  countPending: vi.fn(async (_uid: string, platform: string) => seed.pendingCounts[platform] ?? 0),
  countApprovedSkipped: vi.fn(async (_uid: string, platform: string) => ({
    approved: seed.approved[platform] ?? 0,
    skipped: seed.skipped[platform] ?? 0,
  })),
  lastPostAt: vi.fn(async (_uid: string, platform: string) => seed.lastPostAt[platform] ?? null),
}));

vi.mock('@/lib/db', () => ({
  db: {
    insert: (table: { _label?: string }) => ({
      values: async (row: Record<string, unknown>) => {
        inserts.push({ table: table._label ?? 'unknown', row });
      },
    }),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  channelScores: { _label: 'channel_scores' },
  moduleScores: { _label: 'module_scores' },
}));

vi.mock('@/lib/platform-config', () => ({
  listAvailablePlatforms: () => ['x', 'reddit'],
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  loggerForJob: (l: unknown) => l,
}));

import { processGrowthRollup } from '../growth-rollup';

function makeJob(userId: string) {
  return {
    id: 'job-1',
    data: { kind: 'user', userId, schemaVersion: 1 as const },
  } as unknown as Job<{ kind: 'user'; userId: string; schemaVersion: 1 }>;
}

beforeEach(() => {
  seed = emptySeed();
  inserts.length = 0;
});

describe('processGrowthRollup', () => {
  it('cold start — inserts zero rows for every platform + the social module', async () => {
    await processGrowthRollup(makeJob('user-1'));
    const channelRows = inserts.filter((i) => i.table === 'channel_scores');
    const moduleRows = inserts.filter((i) => i.table === 'module_scores');
    expect(channelRows).toHaveLength(2);
    expect(channelRows.every((r) => r.row.score === 0)).toBe(true);
    expect(channelRows.every((r) => r.row.threads === 0)).toBe(true);
    expect(channelRows.every((r) => r.row.approveRate === null)).toBe(true);
    expect(moduleRows).toHaveLength(1);
    expect(moduleRows[0].row.moduleId).toBe('social');
    expect(moduleRows[0].row.score).toBe(0);
  });

  it('all-targets-met — score is 100 per channel and per module', async () => {
    seed.threadCounts = { x: 30, reddit: 15 };
    seed.draftCounts = { x: 20, reddit: 10 };
    seed.postCounts = { x: 5, reddit: 3 };
    seed.replyCounts = { x: 15, reddit: 8 };
    await processGrowthRollup(makeJob('user-1'));
    const channelRows = inserts.filter((i) => i.table === 'channel_scores');
    expect(channelRows.every((r) => r.row.score === 100)).toBe(true);
    const moduleRow = inserts.find((i) => i.table === 'module_scores');
    expect(moduleRow!.row.score).toBe(100);
  });

  it('cap rule — over-targeting one metric does not boost the channel score past its real ceiling', async () => {
    seed.threadCounts = { x: 300, reddit: 0 };
    await processGrowthRollup(makeJob('user-1'));
    const xRow = inserts.find((i) => i.table === 'channel_scores' && i.row.platform === 'x');
    expect(xRow!.row.score).toBe(25);
  });

  it('approve_rate denominator zero stays null in the row', async () => {
    await processGrowthRollup(makeJob('user-1'));
    const xRow = inserts.find((i) => i.table === 'channel_scores' && i.row.platform === 'x');
    expect(xRow!.row.approveRate).toBeNull();
  });

  it('approve_rate computes when there are decisions', async () => {
    seed.approved = { x: 3, reddit: 0 };
    seed.skipped = { x: 1, reddit: 0 };
    await processGrowthRollup(makeJob('user-1'));
    const xRow = inserts.find((i) => i.table === 'channel_scores' && i.row.platform === 'x');
    expect(xRow!.row.approveRate).toBeCloseTo(0.75);
  });
});
