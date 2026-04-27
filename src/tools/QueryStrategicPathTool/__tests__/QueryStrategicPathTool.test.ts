/**
 * query_strategic_path unit tests.
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

import { queryStrategicPathTool } from '../QueryStrategicPathTool';
import { strategicPaths } from '@/lib/db/schema';

interface Row {
  id: string;
  userId: string;
  productId: string;
  isActive: boolean;
  narrative: string;
  milestones: unknown;
  thesisArc: unknown;
  contentPillars: unknown;
  channelMix: unknown;
  phaseGoals: unknown;
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

describe('queryStrategicPathTool', () => {
  it('returns null when no row exists', async () => {
    store.register<Row>(strategicPaths, []);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await queryStrategicPathTool.execute({}, ctx);
    expect(result).toBeNull();
  });

  it('returns the validated strategic path when one exists', async () => {
    const longNarrative = 'N'.repeat(250);
    store.register<Row>(strategicPaths, [
      {
        id: 'sp-1',
        userId: 'user-1',
        productId: 'prod-1',
        isActive: true,
        narrative: longNarrative,
        milestones: [
          { atDayOffset: 0, title: 'Launch', successMetric: 'PH top 5', phase: 'launch' },
          { atDayOffset: 7, title: 'Week 1', successMetric: '100 signups', phase: 'compound' },
          { atDayOffset: 30, title: 'Month 1', successMetric: '$1k MRR', phase: 'compound' },
        ],
        thesisArc: [
          {
            weekStart: '2026-01-01',
            theme: 'Thesis',
            angleMix: ['claim'],
          },
        ],
        contentPillars: ['A', 'B', 'C'],
        channelMix: { x: { perWeek: 5, preferredHours: [9, 15] } },
        phaseGoals: { foundation: 'Ship' },
      },
    ]);

    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await queryStrategicPathTool.execute({}, ctx);
    expect(result).not.toBeNull();
    expect(result!.narrative).toBe(longNarrative);
    expect(result!.contentPillars).toEqual(['A', 'B', 'C']);
  });

  it('does NOT return another user\'s strategic path (ownership scoping)', async () => {
    const longNarrative = 'N'.repeat(250);
    store.register<Row>(strategicPaths, [
      {
        id: 'sp-otheruser',
        userId: 'user-other',
        productId: 'prod-1', // same productId but different user
        isActive: true,
        narrative: longNarrative,
        milestones: [
          { atDayOffset: 0, title: 'L', successMetric: 'M', phase: 'launch' },
          { atDayOffset: 7, title: 'W1', successMetric: 'M', phase: 'compound' },
          { atDayOffset: 30, title: 'M1', successMetric: 'M', phase: 'compound' },
        ],
        thesisArc: [{ weekStart: '2026-01-01', theme: 'T', angleMix: ['claim'] }],
        contentPillars: ['A', 'B', 'C'],
        channelMix: { x: { perWeek: 5, preferredHours: [9] } },
        phaseGoals: {},
      },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await queryStrategicPathTool.execute({}, ctx);
    expect(result).toBeNull();
  });

  it('rejects unexpected input keys via strict schema', () => {
    const parse = queryStrategicPathTool.inputSchema.safeParse({ foo: 'bar' });
    expect(parse.success).toBe(false);
  });
});
