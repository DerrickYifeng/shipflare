/**
 * plan-execute-sweeper coverage.
 *
 * The sweeper is responsible for two paths:
 *
 *   1. content_post draft batching — pulls due content_post + planned +
 *      approve rows, atomically claims them (planned → drafting), and
 *      invokes `processPostsBatchTool.execute()` directly per
 *      (userId, productId) group. No `agent_run` spawn, no team
 *      conversation — the sweeper is a cron and the tool is its own
 *      orchestrator.
 *
 *   2. The legacy per-row plan-execute enqueue path for every other
 *      (kind, phase) combination, which we keep covered indirectly
 *      via plan-execute.test.ts.
 *
 * This test focuses on path 1 — the tool dispatch — to lock in:
 *   - rows actually flip planned → drafting (claim is atomic)
 *   - drafted/skipped rows are NOT touched
 *   - exactly ONE tool call per group, with the claimed planItemIds
 *   - on tool failure, claimed rows are reset back to `planned` for retry
 *   - the legacy per-row enqueue is NOT also fired for the same rows
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

// ---------------------------------------------------------------------------
// Mock harness
// ---------------------------------------------------------------------------

interface PlanItemRow {
  id: string;
  userId: string;
  productId: string;
  kind: string;
  state: string;
  userAction: string;
  channel: string | null;
  scheduledAt: Date;
  [key: string]: unknown;
}

const planItemRows: PlanItemRow[] = [];

// Each table is a tagged proxy. Accessing `planItems.id` returns
// `{ _col: 'id', _table: 'plan_items' }`; the in-memory db mock keys
// off `_table` to figure out which table to read/write.
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

vi.mock('@/lib/db/schema', () => ({
  planItems: PLAN_ITEMS_PROXY,
}));

// drizzle-orm mocks. We model the operators as opaque sentinels and
// dispatch on their `.kind` so the in-memory builder can interpret
// which rows match.
interface FilterSentinel {
  kind: string;
  // The sentinel carries enough info to evaluate it against a row.
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
    inArray: (col: unknown, values: unknown[]): FilterSentinel => {
      const name = colName(col);
      return {
        kind: 'inArray',
        match: (row) => (name ? values.includes(row[name]) : true),
      };
    },
    lte: (col: unknown, value: Date): FilterSentinel => {
      const name = colName(col);
      return {
        kind: 'lte',
        match: (row) => {
          if (!name) return false;
          const v = row[name];
          if (v instanceof Date && value instanceof Date)
            return v.getTime() <= value.getTime();
          return false;
        },
      };
    },
    and: (...parts: FilterSentinel[]): FilterSentinel => ({
      kind: 'and',
      match: (row) => parts.every((p) => p.match(row)),
    }),
    or: (...parts: FilterSentinel[]): FilterSentinel => ({
      kind: 'or',
      match: (row) => parts.some((p) => p.match(row)),
    }),
    sql: Object.assign(() => 'sql-token', { raw: () => 'sql-token' }),
  };
});

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
    return [];
  }

  function selectFrom(table: unknown) {
    return {
      where: (cond: FilterSentinel) => {
        const filtered = tableRows(table).filter((r) => cond.match(r));
        return {
          limit: (n: number) => Promise.resolve(filtered.slice(0, n)),
        };
      },
    };
  }

  function update(table: unknown) {
    return {
      set: (patch: Record<string, unknown>) => ({
        where: (cond: FilterSentinel) => {
          const list = tableRows(table);
          // Drop drizzle's `sql\`now()\`` token from the patch — the
          // in-memory mock doesn't model timestamps.
          const cleanPatch: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(patch)) {
            if (k === 'updatedAt') continue;
            cleanPatch[k] = v;
          }
          const updated: Array<{ id: unknown }> = [];
          for (let i = 0; i < list.length; i += 1) {
            if (cond.match(list[i])) {
              list[i] = { ...list[i], ...cleanPatch };
              updated.push({ id: list[i].id });
            }
          }
          return {
            returning: (_cols?: unknown) => Promise.resolve(updated),
          };
        },
      }),
    };
  }

  return {
    db: {
      select: () => ({ from: (table: unknown) => selectFrom(table) }),
      update: (table: unknown) => update(table),
    },
  };
});

// Pipeline events / logger / queue helpers.
vi.mock('@/lib/pipeline-events', () => ({
  recordPipelineEventsBulk: vi.fn().mockResolvedValue(undefined),
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

const enqueuePlanExecuteMock = vi.fn(async (_data: unknown) => 'job-id');
vi.mock('@/lib/queue/plan-execute', () => ({
  enqueuePlanExecute: (data: unknown) => enqueuePlanExecuteMock(data),
}));

// Pipeline-to-tools refactor: the sweeper now invokes
// `processPostsBatchTool.execute()` directly. The legacy
// `spawnMemberAgentRun` / `createAutomationConversation` helpers are
// mocked here only so we can ASSERT they are NOT called for content_post
// drafts. (Other call sites — onboarding finalizer, retry route — still
// use them, but the sweeper no longer does.)
const spawnMemberAgentRunMock = vi.fn(async () => ({
  agentId: 'unused',
  messageId: 'unused',
}));
vi.mock('@/lib/team/spawn-member-agent-run', () => ({
  spawnMemberAgentRun: () => spawnMemberAgentRunMock(),
}));

const createAutomationConversationMock = vi
  .fn()
  .mockResolvedValue('unused-conv');
vi.mock('@/lib/team-conversation-helpers', () => ({
  createAutomationConversation: (...args: unknown[]) =>
    createAutomationConversationMock(...args),
}));

// processPostsBatchTool — the canonical mock for path 1. Test bodies
// override the implementation per-case to simulate success / failure.
const processPostsBatchExecuteMock = vi.fn();
vi.mock(
  '@/tools/ProcessPostsBatchTool/ProcessPostsBatchTool',
  () => ({
    processPostsBatchTool: {
      execute: (input: unknown, ctx: unknown) =>
        processPostsBatchExecuteMock(input, ctx),
    },
  }),
);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function seedPlanItem(init: Partial<PlanItemRow> & { id: string }): void {
  planItemRows.push({
    userId: 'u-1',
    productId: 'p-1',
    kind: 'content_post',
    state: 'planned',
    userAction: 'approve',
    channel: 'x',
    scheduledAt: new Date('2026-04-30T00:00:00Z'),
    ...init,
  });
}

function makeJob(): Job<Record<string, never>> {
  return { id: 'sweep-1', data: {} } as Job<Record<string, never>>;
}

beforeEach(() => {
  planItemRows.length = 0;
  enqueuePlanExecuteMock.mockClear();
  spawnMemberAgentRunMock.mockClear();
  createAutomationConversationMock.mockClear();
  processPostsBatchExecuteMock.mockReset();
  // Default: tool succeeds, no retries.
  processPostsBatchExecuteMock.mockResolvedValue({
    itemsScanned: 0,
    draftsCreated: 0,
    draftsSkipped: 0,
    notes: '',
    details: [],
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('plan-execute-sweeper — content_post batch dispatch via tool', () => {
  it('claims due content_post rows and invokes processPostsBatchTool with claimed ids — NOT spawnMemberAgentRun', async () => {
    seedPlanItem({ id: 'pi-1' });
    seedPlanItem({ id: 'pi-2' });
    // Already-drafted row should be ignored — sweeper only claims `planned`.
    seedPlanItem({ id: 'pi-3', state: 'drafted' });

    const { processPlanExecuteSweeper } = await import(
      '../plan-execute-sweeper'
    );
    await processPlanExecuteSweeper(makeJob());

    // 1. Tool called exactly once with both due plan_item ids.
    expect(processPostsBatchExecuteMock).toHaveBeenCalledTimes(1);
    const [input, ctx] = processPostsBatchExecuteMock.mock.calls[0]!;
    expect((input as { planItemIds: string[] }).planItemIds.sort()).toEqual([
      'pi-1',
      'pi-2',
    ]);

    // 2. Tool context exposes the user/product/db deps the tool reads.
    const toolCtx = ctx as {
      get: <T>(k: string) => T;
      abortSignal: AbortSignal;
    };
    expect(toolCtx.get('userId')).toBe('u-1');
    expect(toolCtx.get('productId')).toBe('p-1');
    expect(toolCtx.get('db')).toBeDefined();

    // 3. No agent_run spawn / team conversation — the tool is the
    //    orchestrator, not a teammate.
    expect(spawnMemberAgentRunMock).not.toHaveBeenCalled();
    expect(createAutomationConversationMock).not.toHaveBeenCalled();

    // 4. No per-row enqueue for content_post draft (path 1 owns it).
    expect(enqueuePlanExecuteMock).not.toHaveBeenCalled();

    // 5. Claimed rows are now in `drafting`. Untouched row stays `drafted`.
    expect(planItemRows.find((r) => r.id === 'pi-1')!.state).toBe('drafting');
    expect(planItemRows.find((r) => r.id === 'pi-2')!.state).toBe('drafting');
    expect(planItemRows.find((r) => r.id === 'pi-3')!.state).toBe('drafted');
  });

  it('groups by (userId, productId) — two users get two tool calls', async () => {
    seedPlanItem({ id: 'a-1', userId: 'u-1', productId: 'p-1' });
    seedPlanItem({ id: 'b-1', userId: 'u-2', productId: 'p-2' });

    const { processPlanExecuteSweeper } = await import(
      '../plan-execute-sweeper'
    );
    await processPlanExecuteSweeper(makeJob());

    expect(processPostsBatchExecuteMock).toHaveBeenCalledTimes(2);
    const userIds = processPostsBatchExecuteMock.mock.calls
      .map((c) => (c[1] as { get: <T>(k: string) => T }).get<string>('userId'))
      .sort();
    expect(userIds).toEqual(['u-1', 'u-2']);
  });

  it('is idempotent — a re-run after the first claim invokes the tool zero times', async () => {
    seedPlanItem({ id: 'pi-A' });
    seedPlanItem({ id: 'pi-B' });

    const { processPlanExecuteSweeper } = await import(
      '../plan-execute-sweeper'
    );
    await processPlanExecuteSweeper(makeJob());
    expect(processPostsBatchExecuteMock).toHaveBeenCalledTimes(1);

    processPostsBatchExecuteMock.mockClear();
    await processPlanExecuteSweeper(makeJob());
    // Second sweep — both rows are now in `drafting`, so the candidate
    // query returns nothing and no tool call is made.
    expect(processPostsBatchExecuteMock).not.toHaveBeenCalled();
  });

  it('on tool dispatch failure, resets claimed rows back to planned for retry', async () => {
    seedPlanItem({ id: 'pi-fail-1' });
    seedPlanItem({ id: 'pi-fail-2' });

    processPostsBatchExecuteMock.mockRejectedValueOnce(
      new Error('xAI quota exhausted'),
    );

    const { processPlanExecuteSweeper } = await import(
      '../plan-execute-sweeper'
    );
    await processPlanExecuteSweeper(makeJob());

    // Tool was attempted, but threw. Both rows must be back in
    // `planned` so the next tick retries them.
    expect(processPostsBatchExecuteMock).toHaveBeenCalledTimes(1);
    expect(planItemRows.find((r) => r.id === 'pi-fail-1')!.state).toBe(
      'planned',
    );
    expect(planItemRows.find((r) => r.id === 'pi-fail-2')!.state).toBe(
      'planned',
    );
  });

  it('does NOT batch content_post rows that are scheduled in the future', async () => {
    seedPlanItem({
      id: 'pi-future',
      scheduledAt: new Date('3000-01-01T00:00:00Z'),
    });

    const { processPlanExecuteSweeper } = await import(
      '../plan-execute-sweeper'
    );
    await processPlanExecuteSweeper(makeJob());

    expect(processPostsBatchExecuteMock).not.toHaveBeenCalled();
    expect(planItemRows.find((r) => r.id === 'pi-future')!.state).toBe(
      'planned',
    );
  });

  it('does NOT short-circuit other-kind rows — content_reply still flows through per-row enqueue', async () => {
    seedPlanItem({ id: 'pi-reply', kind: 'content_reply', channel: 'x' });

    const { processPlanExecuteSweeper } = await import(
      '../plan-execute-sweeper'
    );
    await processPlanExecuteSweeper(makeJob());

    // No tool invocation from the batch path (kind != content_post).
    expect(processPostsBatchExecuteMock).not.toHaveBeenCalled();
    // Per-row enqueue runs as before for content_reply + planned + approve.
    expect(enqueuePlanExecuteMock).toHaveBeenCalledTimes(1);
    const call = enqueuePlanExecuteMock.mock.calls[0]?.[0] as {
      planItemId: string;
      phase: string;
    };
    expect(call.planItemId).toBe('pi-reply');
    expect(call.phase).toBe('draft');
  });
});
