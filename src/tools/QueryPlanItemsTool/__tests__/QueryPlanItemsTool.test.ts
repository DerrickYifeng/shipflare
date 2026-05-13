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
import { drafts, planItems } from '@/lib/db/schema';

interface PlanItemRow {
  id: string;
  userId: string;
  productId: string;
  state: string;
  kind: string;
  userAction: string;
  phase: string;
  channel: string | null;
  dueDate: Date;
  sortOrder: number;
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
    dueDate: new Date(),
    sortOrder: 0,
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

  it('content_reply: counts drafts table rows linked to the plan_item (2026-05-13 verification regression)', async () => {
    // Tier 2: the coordinator uses `draftCount` to mechanically verify
    // a specialist's claim before flipping state to `drafted`. For
    // content_reply rows, draftCount must count only this plan_item's
    // own `pending` drafts, scoped to the same userId.
    store.register<PlanItemRow>(planItems, [
      seed({ id: 'pi-x', kind: 'content_reply', channel: 'x' }),
      seed({ id: 'pi-reddit', kind: 'content_reply', channel: 'reddit' }),
    ]);
    store.register(drafts, [
      // 3 live drafts on the X slot
      { id: 'd1', userId: 'user-1', planItemId: 'pi-x', status: 'pending' },
      { id: 'd2', userId: 'user-1', planItemId: 'pi-x', status: 'pending' },
      { id: 'd3', userId: 'user-1', planItemId: 'pi-x', status: 'pending' },
      // rejected → excluded
      { id: 'd4', userId: 'user-1', planItemId: 'pi-x', status: 'rejected' },
      // other user's draft → excluded
      { id: 'd5', userId: 'user-2', planItemId: 'pi-x', status: 'pending' },
      // 1 draft on the Reddit slot
      { id: 'd6', userId: 'user-1', planItemId: 'pi-reddit', status: 'pending' },
      // orphaned draft (planItemId null) → excluded
      { id: 'd7', userId: 'user-1', planItemId: null, status: 'pending' },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const rows = await queryPlanItemsTool.execute({}, ctx);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('pi-x')?.draftCount).toBe(3);
    expect(byId.get('pi-reddit')?.draftCount).toBe(1);
  });

  it('returns draftCount: 0 when no drafts exist for a plan_item', async () => {
    store.register<PlanItemRow>(planItems, [seed({ id: 'pi-empty' })]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const rows = await queryPlanItemsTool.execute({}, ctx);
    expect(rows[0]?.draftCount).toBe(0);
  });

  it('content_post: draftCount = 1 when `output.draft_body` is non-empty (2026-05-13 false-positive fix)', async () => {
    // Production incident: content_post slots persist body inline via
    // DraftPostTool (`plan_items.output.draft_body` + state='drafted'),
    // NEVER inserting a `drafts` row. Before this branch, the
    // coordinator's Tier 2 verification saw `draftCount: 0` for every
    // drafted post and warned the founder of a phantom persistence
    // failure. Body presence = 1, absence = 0.
    store.register<PlanItemRow>(planItems, [
      seed({
        id: 'pi-post-drafted',
        kind: 'content_post',
        state: 'drafted',
        // @ts-expect-error — `output` exists on the runtime schema but
        // isn't in the test fixture's narrow PlanItemRow type
        output: { draft_body: 'A first-week ShipFlare post body.' },
      }),
      seed({
        id: 'pi-post-empty',
        kind: 'content_post',
        state: 'planned',
        // No draft_body → counts as 0.
      }),
      seed({
        id: 'pi-post-whitespace',
        kind: 'content_post',
        state: 'planned',
        // @ts-expect-error
        output: { draft_body: '   ' }, // whitespace-only → 0
      }),
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const rows = await queryPlanItemsTool.execute({}, ctx);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('pi-post-drafted')?.draftCount).toBe(1);
    expect(byId.get('pi-post-empty')?.draftCount).toBe(0);
    expect(byId.get('pi-post-whitespace')?.draftCount).toBe(0);
  });
});
