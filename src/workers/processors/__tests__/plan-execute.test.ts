import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PlanExecuteJobData } from '@/lib/queue/plan-execute';
import type { PlanItemState, PlanItemUserAction } from '@/lib/plan-state';
import type { DispatchResult } from '@/lib/approve-dispatch';

// ---------------------------------------------------------------------------
// In-memory plan_items fixture. Each test primes one row's initial state
// via `seedItem()`; the db mock exposes select/update that read/write this
// map. Integration-style coverage of the plan-execute state machine without
// standing up Postgres.
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  userId: string;
  productId: string;
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
    productId: 'p-1',
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

// ---------------------------------------------------------------------------
// Approve-loaders + dispatcher mocks for the execute phase dispatcher path.
//
// Phase J Task 2 deleted the writer-team-run enqueue path from
// plan-execute (content_post drafts are now batched by the
// plan-execute-sweeper into a single content-manager(post_batch)
// team-run per user). The processor no longer imports `ensureTeamExists`
// / `enqueueTeamRun` / `createAutomationConversation`, so those mocks
// are gone too.
// ---------------------------------------------------------------------------

// Default: no linked draft. Individual tests override via mockResolvedValueOnce.
const findDraftIdForPlanItemMock = vi.fn(
  async (_planItemId: string): Promise<string | null> => null,
);
const loadDispatchInputForDraftMock = vi.fn(
  async (_draftId: string, _userId: string): Promise<unknown> => null,
);
vi.mock('@/lib/approve-loaders', () => ({
  findDraftIdForPlanItem: (planItemId: string) =>
    findDraftIdForPlanItemMock(planItemId),
  loadDispatchInputForDraft: (draftId: string, userId: string) =>
    loadDispatchInputForDraftMock(draftId, userId),
}));

// Default: returns 'queued'. Individual tests override as needed.
const dispatchApproveMock = vi.fn(
  async (_input: unknown): Promise<DispatchResult> => ({ kind: 'queued', delayMs: 0 }),
);
vi.mock('@/lib/approve-dispatch', () => ({
  dispatchApprove: (input: unknown) => dispatchApproveMock(input),
}));

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
  findDraftIdForPlanItemMock.mockClear();
  loadDispatchInputForDraftMock.mockClear();
  dispatchApproveMock.mockClear();
  // Reset to default: no linked draft, dispatcher returns queued.
  findDraftIdForPlanItemMock.mockResolvedValue(null);
  loadDispatchInputForDraftMock.mockResolvedValue(null);
  dispatchApproveMock.mockResolvedValue({ kind: 'queued', delayMs: 0 });
});

describe('processPlanExecute — draft phase', () => {
  it('treats content_post + x draft as a no-op (sweeper owns the dispatch)', async () => {
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

    // Phase J Task 2: content_post drafts are batched by the
    // plan-execute-sweeper, NOT fired per-row from plan-execute.
    // A residual draft job that still lands here is a silent no-op —
    // the row stays in `planned` and the sweeper picks it up next
    // tick (or the row was already claimed and is in `drafting`).
    expect(rows.get('item-1')!.state).toBe('planned');
  });

  it('treats content_post + reddit draft as a no-op (sweeper owns the dispatch)', async () => {
    const { processPlanExecute } = await import('../plan-execute');
    seedItem({
      id: 'item-r',
      kind: 'content_post',
      channel: 'reddit',
      userAction: 'approve',
      state: 'planned',
    });

    await processPlanExecute(
      makeJob({ schemaVersion: 1, planItemId: 'item-r', userId: 'u-1', phase: 'draft' }),
    );

    expect(rows.get('item-r')!.state).toBe('planned');
  });

  it('leaves a content_post row in `drafting` untouched (sweeper-claimed)', async () => {
    const { processPlanExecute } = await import('../plan-execute');
    // The sweeper flipped this row planned → drafting and dispatched a
    // batch; if a stale per-row plan-execute draft job arrives now,
    // the processor must NOT advance state — `draft_post` is the only
    // path to `drafted`.
    seedItem({
      id: 'item-claimed',
      kind: 'content_post',
      channel: 'x',
      userAction: 'approve',
      state: 'drafting',
    });

    await processPlanExecute(
      makeJob({ schemaVersion: 1, planItemId: 'item-claimed', userId: 'u-1', phase: 'draft' }),
    );

    expect(rows.get('item-claimed')!.state).toBe('drafting');
  });

  it('marks row as failed when the dispatch route is missing (content_reply + reddit has no wired route)', async () => {
    const { processPlanExecute } = await import('../plan-execute');
    // content_reply + reddit has no dispatch entry (only content_reply
    // + x is wired), so the processor falls through to the "no route"
    // failure path. content_post is short-circuited above, so this
    // path covers the legacy dispatch table only.
    seedItem({
      id: 'item-3',
      kind: 'content_reply',
      channel: 'reddit',
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
  it('drives approved → executing and queues for posting (content_post + x)', async () => {
    const { processPlanExecute } = await import('../plan-execute');
    seedItem({
      id: 'item-4',
      kind: 'content_post',
      channel: 'x',
      userAction: 'approve',
      state: 'approved',
    });

    // Wire up a linked draft + successful dispatch.
    findDraftIdForPlanItemMock.mockResolvedValueOnce('draft-4');
    loadDispatchInputForDraftMock.mockResolvedValueOnce({
      draft: { id: 'draft-4', userId: 'u-1', threadId: 'th-1', draftType: 'original_post', replyBody: 'hi', planItemId: 'item-4' },
      thread: { id: 'th-1', platform: 'x', externalId: '123' },
      channelId: 'ch-1',
      connectedAgeDays: 10,
    });
    dispatchApproveMock.mockResolvedValueOnce({ kind: 'queued', delayMs: 500 });

    await processPlanExecute(
      makeJob({ schemaVersion: 1, planItemId: 'item-4', userId: 'u-1', phase: 'execute' }),
    );

    // State advances to 'executing'; the posting worker completes it to
    // 'completed' async (Task 9). Plan-execute only queues the job.
    expect(rows.get('item-4')!.state).toBe('executing');
    expect(dispatchApproveMock).toHaveBeenCalledTimes(1);
  });

  it('drives planned+auto → executing → completed for metrics_compute', async () => {
    const { processPlanExecute } = await import('../plan-execute');
    // Phase E Day 3 deleted the analytics-summarize skill, but the dispatch
    // table still carries a shell route for metrics_compute so the state
    // machine can advance the row to completed until a replacement lands.
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
      skillName: 'custom-launch-skill',
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

    // Step 2: draft phase — Phase J Task 2: plan-execute is a no-op
    // for content_post (sweeper batches it). Simulate the
    // plan-execute-sweeper claim (planned → drafting) and the
    // content-manager(post_batch) team-run completing draft_post
    // (drafting → drafted) directly.
    await processPlanExecute(
      makeJob({ schemaVersion: 1, planItemId: 'item-sm', userId: 'u-1', phase: 'draft' }),
    );
    expect(rows.get('item-sm')!.state).toBe('planned');
    // Simulate sweeper claim → content-manager → draft_post.
    rows.set('item-sm', { ...rows.get('item-sm')!, state: 'drafting' });
    rows.set('item-sm', { ...rows.get('item-sm')!, state: 'drafted' });

    // Step 3: draft-review passes — Phase 8's API or a chained
    // processor moves drafted → ready_for_review
    const drafted = rows.get('item-sm')!;
    rows.set('item-sm', { ...drafted, state: 'ready_for_review' });

    // Step 4: user approves — Phase 8's API moves
    // ready_for_review → approved
    const ready = rows.get('item-sm')!;
    rows.set('item-sm', { ...ready, state: 'approved' });

    // Step 5: sweeper picks up approved + fires execute phase.
    // Wire up a linked draft + successful dispatch so the path progresses.
    findDraftIdForPlanItemMock.mockResolvedValueOnce('draft-sm');
    loadDispatchInputForDraftMock.mockResolvedValueOnce({
      draft: { id: 'draft-sm', userId: 'u-1', threadId: 'th-sm', draftType: 'original_post', replyBody: 'body', planItemId: 'item-sm' },
      thread: { id: 'th-sm', platform: 'x', externalId: '999' },
      channelId: 'ch-1',
      connectedAgeDays: 5,
    });
    dispatchApproveMock.mockResolvedValueOnce({ kind: 'queued', delayMs: 0 });

    await processPlanExecute(
      makeJob({ schemaVersion: 1, planItemId: 'item-sm', userId: 'u-1', phase: 'execute' }),
    );
    // State is 'executing' — the posting worker (Task 9) will flip it to
    // 'completed' async. Plan-execute's job ends after dispatching.
    expect(rows.get('item-sm')!.state).toBe('executing');
    expect(dispatchApproveMock).toHaveBeenCalledTimes(1);
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
