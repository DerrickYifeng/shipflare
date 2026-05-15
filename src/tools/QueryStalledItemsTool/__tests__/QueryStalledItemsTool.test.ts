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

import { queryStalledItemsTool } from '../QueryStalledItemsTool';
import { planItems } from '@/lib/db/schema';

interface PlanItemRow {
  id: string;
  userId: string;
  productId: string;
  state: string;
  title: string;
  dueDate: Date;
  sortOrder: number;
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
  it('returns planned + drafted rows whose dueDate is in the past, scoped to user/product', async () => {
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000); // tomorrow
    store.register<PlanItemRow>(planItems, [
      {
        id: 'stalled-planned',
        userId: 'user-1',
        productId: 'prod-1',
        state: 'planned',
        title: 'Stalled planned',
        dueDate: past,
        sortOrder: 0,
      },
      {
        id: 'stalled-drafted',
        userId: 'user-1',
        productId: 'prod-1',
        state: 'drafted',
        title: 'Stalled drafted',
        dueDate: past,
        sortOrder: 1,
      },
      {
        id: 'future-planned',
        userId: 'user-1',
        productId: 'prod-1',
        state: 'planned',
        title: 'Future planned',
        dueDate: future,
        sortOrder: 0,
      },
      {
        id: 'completed-past',
        userId: 'user-1',
        productId: 'prod-1',
        state: 'completed',
        title: 'Completed',
        dueDate: past,
        sortOrder: 0,
      },
      {
        id: 'otheruser',
        userId: 'user-2',
        productId: 'prod-1',
        state: 'planned',
        title: 'Other user',
        dueDate: past,
        sortOrder: 0,
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
