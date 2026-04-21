/**
 * query_last_week_completions unit tests.
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

import { queryLastWeekCompletionsTool } from '../QueryCompletions';
import { weekBoundsForOffset } from '../Query';
import { planItems } from '@/lib/db/schema';

interface PlanItemRow {
  id: string;
  userId: string;
  productId: string;
  state: string;
  kind: string;
  title: string;
  channel: string | null;
  params: unknown;
  completedAt: Date | null;
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

describe('queryLastWeekCompletionsTool', () => {
  it('returns completed items within last week window', async () => {
    const lastWeek = weekBoundsForOffset(new Date(), -1);
    const midLastWeek = new Date(
      (lastWeek.start.getTime() + lastWeek.end.getTime()) / 2,
    );
    const thisWeek = weekBoundsForOffset(new Date(), 0);
    const midThisWeek = new Date(
      (thisWeek.start.getTime() + thisWeek.end.getTime()) / 2,
    );

    store.register<PlanItemRow>(planItems, [
      {
        id: 'last-week-done',
        userId: 'user-1',
        productId: 'prod-1',
        state: 'completed',
        kind: 'content_post',
        title: 'Last week post',
        channel: 'x',
        params: { angle: 'claim' },
        completedAt: midLastWeek,
        scheduledAt: midLastWeek,
      },
      {
        id: 'this-week-done',
        userId: 'user-1',
        productId: 'prod-1',
        state: 'completed',
        kind: 'content_post',
        title: 'This week post',
        channel: 'x',
        params: { angle: 'story' },
        completedAt: midThisWeek,
        scheduledAt: midThisWeek,
      },
      {
        id: 'last-week-drafted',
        userId: 'user-1',
        productId: 'prod-1',
        state: 'drafted',
        kind: 'content_post',
        title: 'Drafted',
        channel: 'x',
        params: {},
        completedAt: midLastWeek,
        scheduledAt: midLastWeek,
      },
      {
        id: 'otheruser',
        userId: 'user-2',
        productId: 'prod-1',
        state: 'completed',
        kind: 'content_post',
        title: 'Other user',
        channel: 'x',
        params: {},
        completedAt: midLastWeek,
        scheduledAt: midLastWeek,
      },
    ]);

    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const rows = await queryLastWeekCompletionsTool.execute({}, ctx);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('last-week-done');
    expect(rows[0].channel).toBe('x');
    expect(rows[0].angle).toBe('claim');
  });

  it('returns [] when no completions last week', async () => {
    store.register<PlanItemRow>(planItems, []);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const rows = await queryLastWeekCompletionsTool.execute({}, ctx);
    expect(rows).toEqual([]);
  });

  it('rejects unexpected input keys via strict schema', () => {
    const parse = queryLastWeekCompletionsTool.inputSchema.safeParse({ foo: 1 });
    expect(parse.success).toBe(false);
  });
});
