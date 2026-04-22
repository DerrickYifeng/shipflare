/**
 * query_recent_milestones unit tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolContext } from '@/core/types';
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

import { queryRecentMilestonesTool } from '../QueryRecentMilestonesTool';
import { codeSnapshots } from '@/lib/db/schema';

interface SnapshotRow {
  id: string;
  userId: string;
  productId: string;
  commitSha: string | null;
  diffSummary: string | null;
  changesDetected: boolean;
  lastDiffAt: Date | null;
  scannedAt: Date;
  scanSummary: string | null;
}

function makeCtx(store: InMemoryStore, deps: Record<string, unknown>): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    get<V>(key: string): V {
      if (key in deps) return deps[key] as V;
      if (key === 'db') return store.db as unknown as V;
      throw new Error(`no dep ${key}`);
    },
  };
}

let store: InMemoryStore;
beforeEach(() => {
  store = createInMemoryStore();
});

describe('queryRecentMilestonesTool', () => {
  it('returns rows with changesDetected=true and a diffSummary within the window', async () => {
    const now = Date.now();
    const recent = new Date(now - 3 * 24 * 60 * 60 * 1000);
    const old = new Date(now - 30 * 24 * 60 * 60 * 1000);
    store.register<SnapshotRow>(codeSnapshots, [
      {
        id: 's-recent',
        userId: 'user-1',
        productId: 'prod-1',
        commitSha: 'abc',
        diffSummary: 'Shipped domain tools\n+10 files',
        changesDetected: true,
        lastDiffAt: recent,
        scannedAt: recent,
        scanSummary: null,
      },
      {
        id: 's-old',
        userId: 'user-1',
        productId: 'prod-1',
        commitSha: 'def',
        diffSummary: 'Long ago diff',
        changesDetected: true,
        lastDiffAt: old,
        scannedAt: old,
        scanSummary: null,
      },
      {
        id: 's-nochange',
        userId: 'user-1',
        productId: 'prod-1',
        commitSha: 'ghi',
        diffSummary: null,
        changesDetected: false,
        lastDiffAt: null,
        scannedAt: recent,
        scanSummary: null,
      },
      {
        id: 's-otheruser',
        userId: 'user-2',
        productId: 'prod-1',
        commitSha: 'xyz',
        diffSummary: 'secret shipped',
        changesDetected: true,
        lastDiffAt: recent,
        scannedAt: recent,
        scanSummary: null,
      },
    ]);

    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const rows = await queryRecentMilestonesTool.execute({ sinceDays: 14 }, ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Shipped domain tools');
    expect(rows[0].source).toBe('commit');
    expect(rows[0].atISO).toBe(recent.toISOString());
  });

  it('uses default 14 days when sinceDays is omitted', async () => {
    store.register<SnapshotRow>(codeSnapshots, []);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const rows = await queryRecentMilestonesTool.execute({}, ctx);
    expect(rows).toEqual([]);
  });

  it('rejects sinceDays out of range via schema', () => {
    const parse = queryRecentMilestonesTool.inputSchema.safeParse({
      sinceDays: 0,
    });
    expect(parse.success).toBe(false);
  });
});
