/**
 * query_plan_items unit tests.
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

import { queryPlanItemsTool, weekBoundsForOffset } from '../QueryPlanItemsTool';
import { planItems } from '@/lib/db/schema';

interface PlanItemRow {
  id: string;
  userId: string;
  productId: string;
  state: string;
  kind: string;
  userAction: string;
  phase: string;
  channel: string | null;
  scheduledAt: Date;
  skillName: string | null;
  params: unknown;
  title: string;
  description: string | null;
  completedAt: Date | null;
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

function seed(row: Partial<PlanItemRow>): PlanItemRow {
  return {
    id: crypto.randomUUID(),
    userId: 'user-1',
    productId: 'prod-1',
    state: 'planned',
    kind: 'content_post',
    userAction: 'approve',
    phase: 'foundation',
    channel: 'x',
    scheduledAt: new Date(),
    skillName: null,
    params: {},
    title: 'Row',
    description: null,
    completedAt: null,
    ...row,
  };
}

describe('queryPlanItemsTool', () => {
  it('weekBoundsForOffset returns a Monday start and 7-day span', () => {
    const now = new Date('2026-04-23T12:00:00Z'); // Thursday
    const { start, end } = weekBoundsForOffset(now, 0);
    expect(start.getUTCDay()).toBe(1); // Monday
    expect(start.getUTCHours()).toBe(0);
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('returns rows scoped to ctx user+product only', async () => {
    store.register<PlanItemRow>(planItems, [
      seed({ id: 'a', userId: 'user-1', productId: 'prod-1' }),
      seed({ id: 'b', userId: 'user-2', productId: 'prod-1' }),
      seed({ id: 'c', userId: 'user-1', productId: 'prod-other' }),
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const rows = await queryPlanItemsTool.execute({}, ctx);
    expect(rows.map((r) => r.id).sort()).toEqual(['a']);
  });

  it('filters by status', async () => {
    store.register<PlanItemRow>(planItems, [
      seed({ id: 'pl', state: 'planned' }),
      seed({ id: 'dr', state: 'drafted' }),
      seed({ id: 'co', state: 'completed' }),
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const rows = await queryPlanItemsTool.execute(
      { status: ['planned', 'drafted'] },
      ctx,
    );
    expect(rows.map((r) => r.id).sort()).toEqual(['dr', 'pl']);
  });

  it('filters by id', async () => {
    store.register<PlanItemRow>(planItems, [
      seed({ id: 'wanted' }),
      seed({ id: 'other' }),
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const rows = await queryPlanItemsTool.execute({ id: 'wanted' }, ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('wanted');
  });

  it('rejects limit > 200 via schema', () => {
    const parse = queryPlanItemsTool.inputSchema.safeParse({ limit: 1000 });
    expect(parse.success).toBe(false);
  });

  it('accepts null for optional fields (LLM often emits null for absent fields)', () => {
    const parse = queryPlanItemsTool.inputSchema.safeParse({
      id: null,
      status: null,
      weekOffset: null,
      limit: null,
    });
    expect(parse.success).toBe(true);
  });

  it('rejects invalid state enum values at the schema layer', () => {
    const parse = queryPlanItemsTool.inputSchema.safeParse({
      status: ['planned', 'pending', 'done'],
    });
    expect(parse.success).toBe(false);
  });

  it('treats null filter fields as "not filtering" at runtime', async () => {
    store.register<PlanItemRow>(planItems, [
      seed({ id: 'a', state: 'planned' }),
      seed({ id: 'b', state: 'drafted' }),
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const rows = await queryPlanItemsTool.execute(
      // Simulate the LLM first-turn behavior: all fields explicitly null.
      { id: null, status: null, weekOffset: null, limit: null } as never,
      ctx,
    );
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
});
