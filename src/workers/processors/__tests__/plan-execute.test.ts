import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PlanExecuteJobData } from '@/lib/queue/plan-execute';
import type { PlanItemState, PlanItemUserAction } from '@/lib/plan-state';

// ---------------------------------------------------------------------------
// In-memory plan_items fixture. Each test primes one row's initial state
// via `seedItem()`; the db mock exposes select/update that read/write this
// map. Integration-style coverage of the plan-execute state machine without
// standing up Postgres.
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  userId: string;
  kind: string;
  state: PlanItemState;
  userAction: PlanItemUserAction;
  channel: string | null;
  skillName: string | null;
}

const rows = new Map<string, Row>();

function seedItem(init: Partial<Row> & { id: string; kind: string }): Row {
  const row: Row = {
    userId: 'u-1',
    state: 'planned',
    userAction: 'approve',
    channel: null,
    skillName: null,
    ...init,
  } as Row;
  rows.set(row.id, row);
  return row;
}

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (cond: { id?: string }) => ({
          limit: () => {
            // The processor only ever selects by id = eq(planItems.id, x);
            // we decode the target id from the drizzle `eq()` sentinel
            // emitted by our mocked drizzle-orm (below). The sentinel
            // carries a `.value` we use to look up.
            const id = (cond as unknown as { __eqValue?: string })
              .__eqValue;
            if (!id) return [];
            const row = rows.get(id);
            return row ? [row] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: Partial<Row>) => ({
        where: (cond: { id?: string }) => {
          const id = (cond as unknown as { __eqValue?: string }).__eqValue;
          if (!id) return Promise.resolve([]);
          const row = rows.get(id);
          if (!row) return Promise.resolve([]);
          rows.set(id, { ...row, ...patch });
          return Promise.resolve([{ id }]);
        },
      }),
    }),
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
  return {
    ...actual,
    // Our mock db inspects `cond.__eqValue` to figure out which row the
    // processor wants. Intercept `eq()` so the column reference is
    // replaced with a sentinel carrying the target id.
    eq: (_col: unknown, value: unknown) => ({ __eqValue: value as string }),
    sql: Object.assign(() => ({}), { raw: () => ({}) }),
  };
});

// Avoid the logger touching real stdout noise in test output.
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

function makeJob(data: PlanExecuteJobData): Job<PlanExecuteJobData> {
  return {
    id: `job-${data.planItemId}-${data.phase}`,
    data,
    name: 'transition',
  } as Job<PlanExecuteJobData>;
}

beforeEach(() => {
  rows.clear();
});

describe('processPlanExecute — draft phase', () => {
  it('advances planned → drafted for content_post + approve', async () => {
    const { processPlanExecute } = await import('../plan-execute');
    seedItem({
      id: 'item-1',
      kind: 'content_post',
      channel: 'x',
      userAction: 'approve',
      state: 'planned',
    });

    await processPlanExecute(
      makeJob({ schemaVersion: 1, planItemId: 'item-1', userId: 'u-1', phase: 'draft' }),
    );

    expect(rows.get('item-1')!.state).toBe('drafted');
  });

  it('no-ops when row is no longer in planned state', async () => {
    const { processPlanExecute } = await import('../plan-execute');
    seedItem({
      id: 'item-2',
      kind: 'content_post',
      channel: 'x',
      userAction: 'approve',
      state: 'superseded',
    });

    await processPlanExecute(
      makeJob({ schemaVersion: 1, planItemId: 'item-2', userId: 'u-1', phase: 'draft' }),
    );

    expect(rows.get('item-2')!.state).toBe('superseded');
  });

  it('marks row as failed when kind has no dispatch route', async () => {
    const { processPlanExecute } = await import('../plan-execute');
    seedItem({
      id: 'item-3',
      kind: 'content_post',
      channel: 'reddit', // reddit is intentionally unwired in Phase 7
      userAction: 'approve',
      state: 'planned',
    });

    await processPlanExecute(
      makeJob({ schemaVersion: 1, planItemId: 'item-3', userId: 'u-1', phase: 'draft' }),
    );

    expect(rows.get('item-3')!.state).toBe('failed');
  });
});

describe('processPlanExecute — execute phase', () => {
  it('drives approved → executing → completed for content_post', async () => {
    const { processPlanExecute } = await import('../plan-execute');
    seedItem({
      id: 'item-4',
      kind: 'content_post',
      channel: 'x',
      userAction: 'approve',
      state: 'approved',
    });

    await processPlanExecute(
      makeJob({ schemaVersion: 1, planItemId: 'item-4', userId: 'u-1', phase: 'execute' }),
    );

    expect(rows.get('item-4')!.state).toBe('completed');
  });

  it('drives planned+auto → executing → completed for metrics_compute', async () => {
    const { processPlanExecute } = await import('../plan-execute');
    seedItem({
      id: 'item-5',
      kind: 'metrics_compute',
      channel: null,
      userAction: 'auto',
      state: 'planned',
    });

    await processPlanExecute(
      makeJob({ schemaVersion: 1, planItemId: 'item-5', userId: 'u-1', phase: 'execute' }),
    );

    expect(rows.get('item-5')!.state).toBe('completed');
  });

  it('completes a launch_asset row with no executeSkill registered', async () => {
    const { processPlanExecute } = await import('../plan-execute');
    // launch_asset default route has executeSkill=null (user hosts the
    // asset off-platform). Processor should still advance the state.
    seedItem({
      id: 'item-6',
      kind: 'launch_asset',
      channel: null,
      userAction: 'approve',
      state: 'approved',
      skillName: 'draft-waitlist-page',
    });

    await processPlanExecute(
      makeJob({ schemaVersion: 1, planItemId: 'item-6', userId: 'u-1', phase: 'execute' }),
    );

    expect(rows.get('item-6')!.state).toBe('completed');
  });
});

describe('processPlanExecute — integration: full SM walk', () => {
  it('drives a content_post from planned → drafted → (manual ready_for_review + approved) → completed', async () => {
    const { processPlanExecute } = await import('../plan-execute');

    // Step 1: seed a planned + approve item
    seedItem({
      id: 'item-sm',
      kind: 'content_post',
      channel: 'x',
      userAction: 'approve',
      state: 'planned',
    });

    // Step 2: draft phase — simulates plan-execute-sweeper picking it up
    await processPlanExecute(
      makeJob({ schemaVersion: 1, planItemId: 'item-sm', userId: 'u-1', phase: 'draft' }),
    );
    expect(rows.get('item-sm')!.state).toBe('drafted');

    // Step 3: draft-review passes — Phase 8's API or a chained
    // processor moves drafted → ready_for_review
    const drafted = rows.get('item-sm')!;
    rows.set('item-sm', { ...drafted, state: 'ready_for_review' });

    // Step 4: user approves — Phase 8's API moves
    // ready_for_review → approved
    const ready = rows.get('item-sm')!;
    rows.set('item-sm', { ...ready, state: 'approved' });

    // Step 5: sweeper picks up approved + fires execute phase
    await processPlanExecute(
      makeJob({ schemaVersion: 1, planItemId: 'item-sm', userId: 'u-1', phase: 'execute' }),
    );
    expect(rows.get('item-sm')!.state).toBe('completed');
  });
});

describe('processPlanExecute — defensive paths', () => {
  it('drops the job silently when planItemId is missing', async () => {
    const { processPlanExecute } = await import('../plan-execute');
    // Nothing seeded — processor should return without throwing.
    await expect(
      processPlanExecute(
        makeJob({ schemaVersion: 1, planItemId: 'ghost', userId: 'u-1', phase: 'draft' }),
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses to move a terminal-state row', async () => {
    const { processPlanExecute } = await import('../plan-execute');
    seedItem({
      id: 'item-term',
      kind: 'content_post',
      channel: 'x',
      userAction: 'approve',
      state: 'completed',
    });

    await processPlanExecute(
      makeJob({ schemaVersion: 1, planItemId: 'item-term', userId: 'u-1', phase: 'draft' }),
    );

    // Terminal state: no transition. Row stays `completed`.
    expect(rows.get('item-term')!.state).toBe('completed');
  });
});
