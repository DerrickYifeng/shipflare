/**
 * update_plan_item unit tests.
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

import { updatePlanItemTool } from '../Update';
import { planItems } from '@/lib/db/schema';

interface PlanItemRow {
  id: string;
  userId: string;
  productId: string;
  state: string;
  title: string;
  description: string | null;
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
  store.register<PlanItemRow>(planItems, [
    {
      id: 'pi-1',
      userId: 'user-1',
      productId: 'prod-1',
      state: 'planned',
      title: 'Original title',
      description: null,
      scheduledAt: new Date('2026-04-22T09:00:00.000Z'),
    },
    {
      id: 'pi-other',
      userId: 'user-2',
      productId: 'prod-2',
      state: 'planned',
      title: 'Other user row',
      description: null,
      scheduledAt: new Date('2026-04-22T09:00:00.000Z'),
    },
  ]);
});

describe('updatePlanItemTool', () => {
  it('updates title and state on own row', async () => {
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await updatePlanItemTool.execute(
      { id: 'pi-1', patch: { title: 'New title', state: 'drafted' } },
      ctx,
    );
    expect(result).toEqual({ updated: true });
    const row = store
      .get<PlanItemRow>(planItems)
      .find((r) => r.id === 'pi-1')!;
    expect(row.title).toBe('New title');
    expect(row.state).toBe('drafted');
  });

  it('returns not_found for an unknown id', async () => {
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await updatePlanItemTool.execute(
      { id: 'pi-nope', patch: { title: 'x' } },
      ctx,
    );
    expect(result).toEqual({ updated: false, reason: 'not_found' });
  });

  it('refuses to update another user\'s row (not_owner)', async () => {
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await updatePlanItemTool.execute(
      { id: 'pi-other', patch: { title: 'hacked' } },
      ctx,
    );
    expect(result).toEqual({ updated: false, reason: 'not_owner' });
    // Row untouched.
    const row = store
      .get<PlanItemRow>(planItems)
      .find((r) => r.id === 'pi-other')!;
    expect(row.title).toBe('Other user row');
  });

  it('returns empty_patch when patch has no keys', async () => {
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await updatePlanItemTool.execute(
      { id: 'pi-1', patch: {} },
      ctx,
    );
    expect(result).toEqual({ updated: false, reason: 'empty_patch' });
  });

  it('rejects unknown patch keys via strict schema', () => {
    const parse = updatePlanItemTool.inputSchema.safeParse({
      id: 'pi-1',
      patch: { foo: 'bar' },
    });
    expect(parse.success).toBe(false);
  });
});
