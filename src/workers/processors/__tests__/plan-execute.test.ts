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
    // Chat refactor: plan-execute mints a conversation for its writer
    // team-run via createAutomationConversation. The mock returns a
    // fixed id so enqueueTeamRun gets a valid conversationId.
    insert: () => ({
      values: () => ({
        returning: () => [{ id: 'conv-plan-execute-test' }],
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

// Phase E Day 3: writer-agent enqueue path mocks. content_post + x/reddit
// enqueues a team-run via ensureTeamExists + enqueueTeamRun. The writer's
// draft_post tool owns the state flip; the processor returns without
// touching state after a successful enqueue.
const ensureTeamExistsMock = vi.fn(
  async (_userId: string, _productId: string | null) => ({
    teamId: 'team-1',
    memberIds: {
      coordinator: 'mem-coord',
      'growth-strategist': 'mem-gs',
      'content-planner': 'mem-cp',
    },
    created: false,
  }),
);
vi.mock('@/lib/team-provisioner', () => ({
  ensureTeamExists: (userId: string, productId: string | null) =>
    ensureTeamExistsMock(userId, productId),
}));

const enqueueTeamRunMock = vi.fn(async (_input: Record<string, unknown>) => ({
  runId: 'run-pe-1',
  traceId: 'trace-pe-1',
  alreadyRunning: false,
}));
vi.mock('@/lib/queue/team-run', () => ({
  enqueueTeamRun: (input: Record<string, unknown>) => enqueueTeamRunMock(input),
}));

// ---------------------------------------------------------------------------
// Approve-loaders + dispatcher mocks for the execute phase dispatcher path.
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
  ensureTeamExistsMock.mockClear();
  enqueueTeamRunMock.mockClear();
  findDraftIdForPlanItemMock.mockClear();
  loadDispatchInputForDraftMock.mockClear();
  dispatchApproveMock.mockClear();
  // Reset to default: no linked draft, dispatcher returns queued.
  findDraftIdForPlanItemMock.mockResolvedValue(null);
  loadDispatchInputForDraftMock.mockResolvedValue(null);
  dispatchApproveMock.mockResolvedValue({ kind: 'queued', delayMs: 0 });
});

describe('processPlanExecute — draft phase', () => {
  it('enqueues a writer team-run for content_post + x, leaves state planned', async () => {
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

    // Phase E Day 3: the processor enqueues a team-run; the writer's
    // draft_post tool owns the state flip (planned → drafted) after
    // the team-run completes. The processor itself does not touch
    // state here.
    expect(rows.get('item-1')!.state).toBe('planned');
    expect(ensureTeamExistsMock).toHaveBeenCalledWith('u-1', 'p-1');
    expect(enqueueTeamRunMock).toHaveBeenCalledTimes(1);
    const call = enqueueTeamRunMock.mock.calls[0]?.[0] as {
      teamId: string;
      trigger: string;
      rootMemberId: string;
      goal: string;
    };
    expect(call.teamId).toBe('team-1');
    expect(call.trigger).toBe('draft_post');
    expect(call.rootMemberId).toBe('mem-coord');
    expect(call.goal).toContain('post-writer');
    expect(call.goal).toContain('channel=x');
    expect(call.goal).toContain('item-1');
  });

  it('enqueues a writer team-run for content_post + reddit', async () => {
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
    expect(enqueueTeamRunMock).toHaveBeenCalledTimes(1);
    const call = enqueueTeamRunMock.mock.calls[0]?.[0] as { goal: string };
    expect(call.goal).toContain('post-writer');
    expect(call.goal).toContain('channel=reddit');
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

  it('marks row as failed when the dispatch route is missing (content_reply + reddit has no wired route)', async () => {
    const { processPlanExecute } = await import('../plan-execute');
    // The writer-agent branch only activates on phase='draft' +
    // content_post. content_reply + reddit has neither writer route
    // nor a legacy dispatch entry (only content_reply + x is wired),
    // so the processor falls through to the "no route" failure path.
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

    // Step 2: draft phase — processor enqueues the writer team-run;
    // the writer's draft_post tool UPDATEs state → 'drafted' when it
    // finishes. Here we simulate that DB update directly.
    await processPlanExecute(
      makeJob({ schemaVersion: 1, planItemId: 'item-sm', userId: 'u-1', phase: 'draft' }),
    );
    expect(enqueueTeamRunMock).toHaveBeenCalled();
    expect(rows.get('item-sm')!.state).toBe('planned');
    // Simulate the writer's draft_post tool completing and flipping state.
    const afterEnqueue = rows.get('item-sm')!;
    rows.set('item-sm', { ...afterEnqueue, state: 'drafted' });

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
