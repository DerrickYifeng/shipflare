/**
 * add_plan_item unit tests.
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

import { addPlanItemTool } from '../Add';
import { planItems, plans } from '@/lib/db/schema';

interface PlanRow {
  id: string;
  userId: string;
  productId: string;
  generatedAt: Date;
}
interface PlanItemRow {
  id: string;
  userId: string;
  productId: string;
  planId: string;
  kind: string;
  state: string;
  userAction: string;
  phase: string;
  channel: string | null;
  scheduledAt: Date;
  skillName: string | null;
  params: unknown;
  title: string;
  description: string | null;
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

function validInput() {
  return {
    kind: 'content_post' as const,
    userAction: 'approve' as const,
    phase: 'foundation' as const,
    channel: 'x',
    scheduledAt: '2026-04-22T09:00:00.000Z',
    skillName: 'draft-single-post',
    params: { angle: 'claim' },
    title: 'Ship the write_strategic_path tool',
    description: 'First plan item written by Phase B',
  };
}

let store: InMemoryStore;
beforeEach(() => {
  store = createInMemoryStore();
  store.register<PlanRow>(plans, [
    {
      id: 'plan-1',
      userId: 'user-1',
      productId: 'prod-1',
      generatedAt: new Date('2026-04-20'),
    },
  ]);
  store.register<PlanItemRow>(planItems, []);
});

describe('addPlanItemTool', () => {
  it('INSERTs a plan_items row against the latest plan', async () => {
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await addPlanItemTool.execute(validInput(), ctx);
    expect(result.planItemId).toMatch(/[0-9a-f-]{36}/);
    expect(result.planId).toBe('plan-1');
    const rows = store.get<PlanItemRow>(planItems);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe('user-1');
    expect(rows[0].productId).toBe('prod-1');
    expect(rows[0].kind).toBe('content_post');
    expect(rows[0].scheduledAt).toBeInstanceOf(Date);
    expect(rows[0].params).toEqual({ angle: 'claim' });
  });

  it('uses ctx-injected planId when provided (override path)', async () => {
    store.register<PlanRow>(plans, [
      { id: 'plan-a', userId: 'user-1', productId: 'prod-1', generatedAt: new Date('2026-04-01') },
      { id: 'plan-b', userId: 'user-1', productId: 'prod-1', generatedAt: new Date('2026-04-10') },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1', planId: 'plan-a' });
    const result = await addPlanItemTool.execute(validInput(), ctx);
    expect(result.planId).toBe('plan-a');
  });

  it('errors when no plan exists for the user+product', async () => {
    store.register<PlanRow>(plans, []);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    await expect(addPlanItemTool.execute(validInput(), ctx)).rejects.toThrow(
      /no plan exists/,
    );
    expect(store.get(planItems)).toHaveLength(0);
  });

  it('rejects invalid input (bad kind)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { ...validInput(), kind: 'invalid_kind' } as any;
    const parse = addPlanItemTool.inputSchema.safeParse(bad);
    expect(parse.success).toBe(false);
  });
});
