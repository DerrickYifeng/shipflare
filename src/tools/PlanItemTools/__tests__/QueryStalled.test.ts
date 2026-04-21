/**
 * query_stalled_items unit tests.
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

import { queryStalledItemsTool } from '../QueryStalled';
import { planItems } from '@/lib/db/schema';

interface PlanItemRow {
  id: string;
  userId: string;
  productId: string;
  state: string;
  title: string;
  scheduledAt: Date;
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

describe('queryStalledItemsTool', () => {
  it('returns planned + drafted rows whose scheduledAt is in the past, scoped to user/product', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    store.register<PlanItemRow>(planItems, [
      {
        id: 'stalled-planned',
        userId: 'user-1',
        productId: 'prod-1',
        state: 'planned',
        title: 'Stalled planned',
        scheduledAt: past,
      },
      {
        id: 'stalled-drafted',
        userId: 'user-1',
        productId: 'prod-1',
        state: 'drafted',
        title: 'Stalled drafted',
        scheduledAt: past,
      },
      {
        id: 'future-planned',
        userId: 'user-1',
        productId: 'prod-1',
        state: 'planned',
        title: 'Future planned',
        scheduledAt: future,
      },
      {
        id: 'completed-past',
        userId: 'user-1',
        productId: 'prod-1',
        state: 'completed',
        title: 'Completed',
        scheduledAt: past,
      },
      {
        id: 'otheruser',
        userId: 'user-2',
        productId: 'prod-1',
        state: 'planned',
        title: 'Other user',
        scheduledAt: past,
      },
    ]);

    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const rows = await queryStalledItemsTool.execute({}, ctx);

    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['stalled-drafted', 'stalled-planned']);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('stalled-planned')!.stalledReason).toBe('overdue_unplanned');
    expect(byId.get('stalled-drafted')!.stalledReason).toBe('overdue_drafted');
  });

  it('returns [] when nothing is stalled', async () => {
    store.register<PlanItemRow>(planItems, []);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const rows = await queryStalledItemsTool.execute({}, ctx);
    expect(rows).toEqual([]);
  });

  it('rejects unexpected input keys via strict schema', () => {
    const parse = queryStalledItemsTool.inputSchema.safeParse({ foo: 1 });
    expect(parse.success).toBe(false);
  });
});
