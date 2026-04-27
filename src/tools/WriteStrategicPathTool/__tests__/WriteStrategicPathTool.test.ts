/**
 * write_strategic_path unit tests.
 *
 * Covers:
 *   - Happy path: INSERT when no row exists
 *   - Happy path: UPDATE when a row already exists for (userId, productId)
 *   - Validation failure: invalid strategicPathSchema input
 *   - Authorization: no cross-user write (not applicable since the tool
 *     reads userId+productId from ctx — we assert it writes with the
 *     ctx-provided userId, not some arbitrary id)
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

vi.mock('@/lib/db', () => ({
  db: createInMemoryStore().db, // unused — tools always read ctx.get('db') in tests
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

vi.mock('@/lib/launch-phase', () => ({
  derivePhase: () => 'foundation',
}));

import { writeStrategicPathTool } from '../WriteStrategicPathTool';
import { strategicPaths, products } from '@/lib/db/schema';

interface ProductRow {
  id: string;
  userId: string;
  state: string;
  launchDate: Date | null;
  launchedAt: Date | null;
}
interface StrategicPathRow {
  id: string;
  userId: string;
  productId: string;
  isActive: boolean;
  phase: string;
  narrative: string;
  milestones: unknown;
  thesisArc: unknown;
  contentPillars: unknown;
  channelMix: unknown;
  phaseGoals: unknown;
}

function validPathInput() {
  return {
    narrative:
      'This is a narrative arc that is long enough to satisfy the minimum ' +
      'length of two hundred characters so that strategicPathSchema ' +
      'happily validates the row we pass into the tool. Add a little more ' +
      'filler to safely clear the 200-char floor and some to spare.',
    milestones: [
      {
        atDayOffset: -14,
        title: 'Seed audience warm-up',
        successMetric: 'First 100 followers',
        phase: 'audience' as const,
      },
      {
        atDayOffset: 0,
        title: 'Launch day',
        successMetric: 'Product Hunt top 5',
        phase: 'launch' as const,
      },
      {
        atDayOffset: 30,
        title: 'Post-launch retention',
        successMetric: '30% weekly return',
        phase: 'compound' as const,
      },
    ],
    thesisArc: [
      {
        weekStart: '2026-01-01',
        theme: 'Building in public matters more than polish',
        angleMix: ['claim', 'story'] as Array<'claim' | 'story'>,
      },
    ],
    contentPillars: ['Pillar A', 'Pillar B', 'Pillar C'],
    channelMix: {
      x: {
        perWeek: 7,
        preferredHours: [9, 13, 17],
      },
    },
    phaseGoals: {
      foundation: 'Get infra right',
    },
  };
}

function makeCtx(store: InMemoryStore, deps: Record<string, unknown>): ToolContext {
  const ac = new AbortController();
  return {
    abortSignal: ac.signal,
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
  store.register<ProductRow>(products, [
    {
      id: 'prod-1',
      userId: 'user-1',
      state: 'mvp',
      launchDate: null,
      launchedAt: null,
    },
  ]);
  store.register<StrategicPathRow>(strategicPaths, []);
});

describe('writeStrategicPathTool', () => {
  it('INSERTs a new row when none exists', async () => {
    const ctx = makeCtx(store, {
      userId: 'user-1',
      productId: 'prod-1',
    });
    const result = await writeStrategicPathTool.execute(validPathInput(), ctx);

    expect(result.persisted).toBe('inserted');
    expect(result.pathId).toMatch(/[0-9a-f-]{36}/);
    const rows = store.get<StrategicPathRow>(strategicPaths);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe('user-1');
    expect(rows[0].productId).toBe('prod-1');
    expect(rows[0].isActive).toBe(true);
    expect(rows[0].narrative).toBe(validPathInput().narrative);
  });

  it('UPDATEs the existing row when one already exists', async () => {
    store.register<StrategicPathRow>(strategicPaths, [
      {
        id: 'sp-existing',
        userId: 'user-1',
        productId: 'prod-1',
        isActive: true,
        phase: 'audience',
        narrative: 'old narrative',
        milestones: [],
        thesisArc: [],
        contentPillars: [],
        channelMix: {},
        phaseGoals: {},
      },
    ]);

    const ctx = makeCtx(store, {
      userId: 'user-1',
      productId: 'prod-1',
    });
    const result = await writeStrategicPathTool.execute(validPathInput(), ctx);

    expect(result.persisted).toBe('updated');
    expect(result.pathId).toBe('sp-existing');
    const rows = store.get<StrategicPathRow>(strategicPaths);
    expect(rows).toHaveLength(1);
    // The row we patched should now carry the new narrative.
    expect(rows[0].narrative).toBe(validPathInput().narrative);
  });

  it('rejects invalid input via schema parse', async () => {
    const ctx = makeCtx(store, {
      userId: 'user-1',
      productId: 'prod-1',
    });
    // narrative too short
    const bad = { ...validPathInput(), narrative: 'too short' };
    // The tool's `execute` receives the already-parsed input when called
    // via the agent — for the unit test we invoke the schema directly
    // to prove validation fails.
    const parse = writeStrategicPathTool.inputSchema.safeParse(bad);
    expect(parse.success).toBe(false);

    // Also verify that if we call execute() with invalid input via the
    // generic execute signature, the downstream write doesn't corrupt
    // the store — schemas are enforced by the agent runner, not the
    // tool body itself, so this just confirms the schema rejects.
    expect(() => writeStrategicPathTool.inputSchema.parse(bad)).toThrow();
    expect(store.get(strategicPaths)).toHaveLength(0);
  });

  it('errors when product is not found for the caller', async () => {
    const ctx = makeCtx(store, {
      userId: 'user-evil',
      productId: 'prod-1',
    });
    await expect(
      writeStrategicPathTool.execute(validPathInput(), ctx),
    ).rejects.toThrow(/product prod-1 not found/);
    expect(store.get(strategicPaths)).toHaveLength(0);
  });
});
