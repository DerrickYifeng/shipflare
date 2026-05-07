/**
 * stale-sweeper coverage.
 *
 * The sweeper is an hourly cron that ages out stale rows the founder
 * never acted on:
 *
 *   1. plan_items.state='planned' rows past `scheduledAt + 24h` get
 *      flipped to `state='stale'`.
 *   2. plan_items.state='approved' rows past the same window get
 *      flipped to `state='stale'` (an approved item that never
 *      executed is a broken pipeline, not a live plan).
 *   3. drafts.status='pending' rows past `createdAt + 24h` get flipped
 *      to `status='skipped'` — without this, reply drafts from days
 *      ago keep showing on the Today/Briefing feed forever.
 *
 * Per-user pipeline events emit the marked counts so the events feed
 * shows the cron ran.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

// ---------------------------------------------------------------------------
// Mock harness — modeled after plan-execute-sweeper.test.ts.
// ---------------------------------------------------------------------------

interface PlanItemRow {
  id: string;
  userId: string;
  state: string;
  scheduledAt: Date;
  [key: string]: unknown;
}

interface DraftRow {
  id: string;
  userId: string;
  status: string;
  createdAt: Date;
  [key: string]: unknown;
}

const planItemRows: PlanItemRow[] = [];
const draftRows: DraftRow[] = [];

function tableProxy(name: string): Record<string, { _col: string; _table: string }> & {
  _table: string;
} {
  return new Proxy(
    { _table: name },
    {
      get: (target, prop: string) => {
        if (prop === '_table') return target._table;
        return { _col: prop, _table: name };
      },
    },
  ) as Record<string, { _col: string; _table: string }> & { _table: string };
}

const PLAN_ITEMS_PROXY = tableProxy('plan_items');
const DRAFTS_PROXY = tableProxy('drafts');

vi.mock('@/lib/db/schema', () => ({
  planItems: PLAN_ITEMS_PROXY,
  drafts: DRAFTS_PROXY,
}));

interface FilterSentinel {
  kind: string;
  match: (row: Record<string, unknown>) => boolean;
}

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');

  function colName(col: unknown): string | null {
    if (col && typeof col === 'object' && '_col' in col) {
      return (col as { _col: string })._col;
    }
    return null;
  }

  return {
    ...actual,
    eq: (col: unknown, value: unknown): FilterSentinel => {
      const name = colName(col);
      return {
        kind: 'eq',
        match: (row) => (name ? row[name] === value : true),
      };
    },
    lt: (col: unknown, value: Date): FilterSentinel => {
      const name = colName(col);
      return {
        kind: 'lt',
        match: (row) => {
          if (!name) return false;
          const v = row[name];
          if (v instanceof Date && value instanceof Date)
            return v.getTime() < value.getTime();
          return false;
        },
      };
    },
    and: (...parts: FilterSentinel[]): FilterSentinel => ({
      kind: 'and',
      match: (row) => parts.every((p) => p.match(row)),
    }),
    sql: Object.assign(() => 'sql-token', { raw: () => 'sql-token' }),
  };
});

// Each db.update() call is captured in this array so tests can assert
// the exact sequence of UPDATE-set-where statements the sweeper issued.
interface UpdateCall {
  table: string;
  patch: Record<string, unknown>;
  where: FilterSentinel;
  matchedIds: string[];
}

const updateCalls: UpdateCall[] = [];

vi.mock('@/lib/db', () => {
  function tableName(table: unknown): string | null {
    if (table && typeof table === 'object' && '_table' in table) {
      return (table as { _table: string })._table;
    }
    return null;
  }

  function tableRows(table: unknown): Record<string, unknown>[] {
    const name = tableName(table);
    if (name === 'plan_items') return planItemRows as Record<string, unknown>[];
    if (name === 'drafts') return draftRows as Record<string, unknown>[];
    return [];
  }

  function update(table: unknown) {
    return {
      set: (patch: Record<string, unknown>) => ({
        where: (cond: FilterSentinel) => {
          const list = tableRows(table);
          const cleanPatch: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(patch)) {
            if (k === 'updatedAt') continue;
            cleanPatch[k] = v;
          }
          const updated: Array<{ id: unknown; userId: unknown }> = [];
          const matchedIds: string[] = [];
          for (let i = 0; i < list.length; i += 1) {
            if (cond.match(list[i])) {
              list[i] = { ...list[i], ...cleanPatch };
              updated.push({ id: list[i].id, userId: list[i].userId });
              matchedIds.push(String(list[i].id));
            }
          }
          updateCalls.push({
            table: tableName(table) ?? '',
            patch,
            where: cond,
            matchedIds,
          });
          return {
            returning: (_cols?: unknown) => Promise.resolve(updated),
          };
        },
      }),
    };
  }

  return {
    db: {
      update: (table: unknown) => update(table),
    },
  };
});

const recordPipelineEventsBulkMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/pipeline-events', () => ({
  recordPipelineEventsBulk: (events: unknown) =>
    recordPipelineEventsBulkMock(events),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
  loggerForJob: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function seedPlanItem(init: Partial<PlanItemRow> & { id: string }): void {
  planItemRows.push({
    userId: 'u-1',
    state: 'planned',
    // 2 days ago — well past the 24h cutoff.
    scheduledAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    ...init,
  });
}

function seedDraft(init: Partial<DraftRow> & { id: string }): void {
  draftRows.push({
    userId: 'u-1',
    status: 'pending',
    // 2 days ago — well past the 24h cutoff.
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    ...init,
  });
}

function makeJob(): Job<Record<string, never>> {
  return { id: 'sweep-1', data: {} } as Job<Record<string, never>>;
}

beforeEach(() => {
  planItemRows.length = 0;
  draftRows.length = 0;
  updateCalls.length = 0;
  recordPipelineEventsBulkMock.mockClear();
});

// ---------------------------------------------------------------------------
// Existing behavior: plan_items planned + approved
// ---------------------------------------------------------------------------

describe('stale-sweeper plan_items branch', () => {
  it('marks planned plan_items past scheduledAt + 24h as stale', async () => {
    seedPlanItem({ id: 'pi-1', state: 'planned' });

    const { processStaleSweeper } = await import('../stale-sweeper');
    await processStaleSweeper(makeJob());

    expect(planItemRows.find((r) => r.id === 'pi-1')!.state).toBe('stale');
  });

  it('marks approved plan_items past scheduledAt + 24h as stale', async () => {
    seedPlanItem({ id: 'pi-2', state: 'approved' });

    const { processStaleSweeper } = await import('../stale-sweeper');
    await processStaleSweeper(makeJob());

    expect(planItemRows.find((r) => r.id === 'pi-2')!.state).toBe('stale');
  });

  it('does NOT touch terminal-state plan_items (drafted/completed/failed)', async () => {
    seedPlanItem({ id: 'pi-3', state: 'drafted' });
    seedPlanItem({ id: 'pi-4', state: 'completed' });
    seedPlanItem({ id: 'pi-5', state: 'failed' });

    const { processStaleSweeper } = await import('../stale-sweeper');
    await processStaleSweeper(makeJob());

    expect(planItemRows.find((r) => r.id === 'pi-3')!.state).toBe('drafted');
    expect(planItemRows.find((r) => r.id === 'pi-4')!.state).toBe('completed');
    expect(planItemRows.find((r) => r.id === 'pi-5')!.state).toBe('failed');
  });

  it('does NOT touch planned plan_items still inside the 24h window', async () => {
    seedPlanItem({
      id: 'pi-fresh',
      state: 'planned',
      scheduledAt: new Date(Date.now() - 1 * 60 * 60 * 1000), // 1h ago
    });

    const { processStaleSweeper } = await import('../stale-sweeper');
    await processStaleSweeper(makeJob());

    expect(planItemRows.find((r) => r.id === 'pi-fresh')!.state).toBe(
      'planned',
    );
  });
});

// ---------------------------------------------------------------------------
// New behavior: drafts pending → skipped
// ---------------------------------------------------------------------------

describe('stale-sweeper drafts branch', () => {
  it('marks drafts.status="skipped" when status="pending" AND createdAt < cutoff', async () => {
    seedDraft({ id: 'd-1', status: 'pending' });

    const { processStaleSweeper } = await import('../stale-sweeper');
    await processStaleSweeper(makeJob());

    // The drafts UPDATE is the third call (after planned + approved).
    const draftsUpdate = updateCalls.find((c) => c.table === 'drafts');
    expect(draftsUpdate).toBeDefined();
    expect(draftsUpdate!.patch).toMatchObject({ status: 'skipped' });
    // The where clause matched our seeded pending row.
    expect(draftsUpdate!.matchedIds).toContain('d-1');

    // And the row itself was updated.
    expect(draftRows.find((r) => r.id === 'd-1')!.status).toBe('skipped');
  });

  it('does NOT touch drafts past pending (approved / handed_off / posted)', async () => {
    seedDraft({ id: 'd-pending-old', status: 'pending' });
    seedDraft({ id: 'd-approved', status: 'approved' });
    seedDraft({ id: 'd-handed-off', status: 'handed_off' });
    seedDraft({ id: 'd-posted', status: 'posted' });

    const { processStaleSweeper } = await import('../stale-sweeper');
    await processStaleSweeper(makeJob());

    // Only the pending row gets flipped.
    expect(draftRows.find((r) => r.id === 'd-pending-old')!.status).toBe(
      'skipped',
    );
    expect(draftRows.find((r) => r.id === 'd-approved')!.status).toBe(
      'approved',
    );
    expect(draftRows.find((r) => r.id === 'd-handed-off')!.status).toBe(
      'handed_off',
    );
    expect(draftRows.find((r) => r.id === 'd-posted')!.status).toBe('posted');

    const draftsUpdate = updateCalls.find((c) => c.table === 'drafts');
    expect(draftsUpdate!.matchedIds).toEqual(['d-pending-old']);
  });

  it('does NOT touch pending drafts still inside the 24h window', async () => {
    seedDraft({
      id: 'd-fresh',
      status: 'pending',
      createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000), // 1h ago
    });

    const { processStaleSweeper } = await import('../stale-sweeper');
    await processStaleSweeper(makeJob());

    expect(draftRows.find((r) => r.id === 'd-fresh')!.status).toBe('pending');
  });

  it('emits a per-user pipeline event with draftsMarked count', async () => {
    seedPlanItem({ id: 'pi-1', userId: 'u-1', state: 'planned' });
    seedPlanItem({ id: 'pi-2', userId: 'u-1', state: 'approved' });
    seedDraft({ id: 'd-1', userId: 'u-1', status: 'pending' });
    seedDraft({ id: 'd-2', userId: 'u-1', status: 'pending' });

    const { processStaleSweeper } = await import('../stale-sweeper');
    await processStaleSweeper(makeJob());

    expect(recordPipelineEventsBulkMock).toHaveBeenCalledTimes(1);
    const events = recordPipelineEventsBulkMock.mock.calls[0]![0] as Array<{
      userId: string;
      stage: string;
      metadata: Record<string, unknown>;
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.userId).toBe('u-1');
    expect(events[0]!.stage).toBe('sweeper_run');
    expect(events[0]!.metadata).toMatchObject({
      sweeper: 'stale',
      plannedMarked: 1,
      approvedMarked: 1,
      draftsMarked: 2,
    });
  });

  it('aggregates draftsMarked per user when multiple users have stale drafts', async () => {
    seedDraft({ id: 'd-u1-a', userId: 'u-1', status: 'pending' });
    seedDraft({ id: 'd-u1-b', userId: 'u-1', status: 'pending' });
    seedDraft({ id: 'd-u2-a', userId: 'u-2', status: 'pending' });

    const { processStaleSweeper } = await import('../stale-sweeper');
    await processStaleSweeper(makeJob());

    expect(recordPipelineEventsBulkMock).toHaveBeenCalledTimes(1);
    const events = recordPipelineEventsBulkMock.mock.calls[0]![0] as Array<{
      userId: string;
      metadata: { draftsMarked: number };
    }>;
    const byUser = new Map(events.map((e) => [e.userId, e.metadata.draftsMarked]));
    expect(byUser.get('u-1')).toBe(2);
    expect(byUser.get('u-2')).toBe(1);
  });
});
