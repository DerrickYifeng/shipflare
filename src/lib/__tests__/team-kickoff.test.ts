import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbSelectMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => dbSelectMock(...args),
  },
}));

const getUserChannelsMock = vi.fn().mockResolvedValue(['x']);
vi.mock('@/lib/user-channels', () => ({
  getUserChannels: (...args: unknown[]) => getUserChannelsMock(...args),
}));

// Phase E Task 11: replaced enqueueTeamRun with dispatchLeadMessage. The
// helper inserts a team_messages row addressed to the lead and wakes the
// agent — the test only cares that it was called with the right shape, so
// we mock the whole helper. The factory must be inline (vi.mock is hoisted
// above any `const` declarations, so the mock fn lives inside the factory).
vi.mock('@/lib/team/dispatch-lead-message', () => ({
  dispatchLeadMessage: vi.fn(),
}));

vi.mock('@/lib/team-conversation-helpers', () => ({
  createAutomationConversation: vi.fn().mockResolvedValue('conv-1'),
}));

import {
  ensureKickoffEnqueued,
  buildKickoffGoalText,
} from '../team-kickoff';
import { createAutomationConversation } from '@/lib/team-conversation-helpers';
import { dispatchLeadMessage } from '@/lib/team/dispatch-lead-message';

const dispatchLeadMessageMock = vi.mocked(dispatchLeadMessage);

function buildSelectChain(rows: unknown[]) {
  const chain: {
    from: () => typeof chain;
    where: () => typeof chain;
    orderBy: () => typeof chain;
    limit: () => Promise<unknown[]>;
    then: (r: (v: unknown[]) => unknown) => Promise<unknown>;
  } = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
    then: (resolve) => Promise.resolve(resolve(rows)),
  };
  return chain;
}

/**
 * The kickoff helper does 4 sequential SELECTs:
 *   1. team_messages (idempotency check)
 *   2. products
 *   3. team_members
 *   4. strategic_paths
 *
 * Helper to wire mocks for the "happy path" with a customizable
 * strategic_path row. Defaults to a path with x: 2 posts and 5
 * replies/day to exercise the parallel-spawn branches.
 */
function setupHappyPath(opts?: {
  channels?: string[];
  pathRow?: Record<string, unknown> | null;
  productName?: string;
}): void {
  const productName = opts?.productName ?? 'Shipflare';
  const pathRow =
    opts?.pathRow === null
      ? null
      : opts?.pathRow ?? {
          id: 'path-1',
          thesisArc: [
            {
              weekStart: '2026-05-04',
              theme: 't1',
              angleMix: ['claim'],
              posts: { x: 2, reddit: 0 },
            },
          ],
          channelMix: {
            x: { repliesPerDay: 5, preferredHours: [14] },
          },
        };

  if (opts?.channels) {
    getUserChannelsMock.mockResolvedValueOnce(opts.channels);
  }

  // 1. team_messages lookup → empty (no past kickoff).
  dbSelectMock.mockReturnValueOnce(buildSelectChain([]));
  // 2. products lookup.
  dbSelectMock.mockReturnValueOnce(buildSelectChain([{ name: productName }]));
  // 3. team_members lookup → coordinator present.
  dbSelectMock.mockReturnValueOnce(
    buildSelectChain([{ id: 'm-coord', agentType: 'coordinator' }]),
  );
  // 4. strategic_paths lookup.
  dbSelectMock.mockReturnValueOnce(buildSelectChain(pathRow ? [pathRow] : []));

  dispatchLeadMessageMock.mockResolvedValueOnce({
    runId: 'run-new',
    traceId: 'trace-1',
    alreadyRunning: false,
  });
}

describe('ensureKickoffEnqueued', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.mockReset();
    dispatchLeadMessageMock.mockReset();
    getUserChannelsMock.mockReset();
    getUserChannelsMock.mockResolvedValue(['x']);
  });

  it('skips when a kickoff team_message already exists for the team', async () => {
    // First select() → existing kickoff message (Phase E detection path).
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ id: 'msg-1' }]));

    const result = await ensureKickoffEnqueued({
      userId: 'u1',
      productId: 'p1',
      teamId: 't1',
    });

    expect(result.fired).toBe(false);
    expect(result.reason).toBe('already_kickoffed');
    expect(dispatchLeadMessageMock).not.toHaveBeenCalled();
    expect(createAutomationConversation).not.toHaveBeenCalled();
  });

  it('emits a kickoff goal with explicit (channel × mode) parallel spawn directives', async () => {
    setupHappyPath({
      channels: ['x'],
      pathRow: {
        id: 'path-1',
        thesisArc: [
          {
            weekStart: '2026-05-04',
            theme: 't1',
            angleMix: ['claim'],
            posts: { x: 2, reddit: 0 },
          },
        ],
        channelMix: {
          x: { repliesPerDay: 5, preferredHours: [14] },
        },
      },
    });

    const result = await ensureKickoffEnqueued({
      userId: 'u1',
      productId: 'p1',
      teamId: 't1',
    });

    expect(result.fired).toBe(true);
    expect(result.runId).toBe('run-new');
    expect(result.conversationId).toBe('conv-1');
    expect(dispatchLeadMessageMock).toHaveBeenCalledTimes(1);
    const callArg = dispatchLeadMessageMock.mock.calls[0]![0];
    expect(callArg.trigger).toBe('kickoff');
    expect(callArg.teamId).toBe('t1');
    expect(callArg.conversationId).toBe('conv-1');

    // Calendar anchors + path id present (carried verbatim into the goal).
    expect(callArg.goal).toContain('weekStart=');
    expect(callArg.goal).toContain('now=');
    expect(callArg.goal).toContain('pathId=path-1');

    // Step 1 — plan_items seeding directive.
    expect(callArg.goal).toContain('add_plan_item');

    // Step 2 — explicit (channel × mode) spawn lines.
    // X is connected with 5 replies/day, so reply spawn appears.
    expect(callArg.goal).toContain('(x, reply)');
    expect(callArg.goal).toContain('targetCount: 5');
    // X has 2 posts/week, so post spawn appears.
    expect(callArg.goal).toContain('(x, post)');
    expect(callArg.goal).toContain('post-batch');
    // Reddit is not connected, so no reddit spawn lines.
    expect(callArg.goal).not.toContain('(reddit, reply)');
    expect(callArg.goal).not.toContain('(reddit, post)');

    // Parallel-spawn directive present (engine accepts multiple tool_use
    // blocks per turn).
    expect(callArg.goal).toContain('SINGLE ASSISTANT TURN');

    // Step 3 — update_plan_item directive.
    expect(callArg.goal).toContain("update_plan_item");

    // Legacy specialist agent names are gone (Plan 3 collapse).
    expect(callArg.goal).not.toContain('content-planner');
    expect(callArg.goal).not.toContain('discovery-agent');
    expect(callArg.goal).not.toContain('content-manager');
    expect(callArg.goal).not.toContain('discovery-scout');
  });

  it('emits 4 spawn directives when both X and Reddit are connected with active budgets', async () => {
    setupHappyPath({
      channels: ['x', 'reddit'],
      pathRow: {
        id: 'path-2',
        thesisArc: [
          {
            weekStart: '2026-05-04',
            theme: 't1',
            angleMix: ['claim'],
            posts: { x: 2, reddit: 3 },
          },
        ],
        channelMix: {
          x: { repliesPerDay: 5, preferredHours: [14] },
          reddit: { repliesPerDay: 2, preferredHours: [15] },
        },
      },
    });

    await ensureKickoffEnqueued({
      userId: 'u1',
      productId: 'p1',
      teamId: 't1',
    });

    const callArg = dispatchLeadMessageMock.mock.calls[0]![0];
    expect(callArg.goal).toContain('(x, reply)');
    expect(callArg.goal).toContain('(reddit, reply)');
    expect(callArg.goal).toContain('(x, post)');
    expect(callArg.goal).toContain('(reddit, post)');
    expect(callArg.goal).toContain('targetCount: 5'); // x replies/day
    expect(callArg.goal).toContain('targetCount: 2'); // reddit replies/day
  });

  it('emits 2 spawn directives for a Reddit-only setup', async () => {
    setupHappyPath({
      channels: ['reddit'],
      pathRow: {
        id: 'path-3',
        thesisArc: [
          {
            weekStart: '2026-05-04',
            theme: 't1',
            angleMix: ['claim'],
            posts: { x: 0, reddit: 3 },
          },
        ],
        channelMix: {
          reddit: { repliesPerDay: 2, preferredHours: [15] },
        },
      },
    });

    await ensureKickoffEnqueued({
      userId: 'u1',
      productId: 'p1',
      teamId: 't1',
    });

    const callArg = dispatchLeadMessageMock.mock.calls[0]![0];
    expect(callArg.goal).toContain('(reddit, reply)');
    expect(callArg.goal).toContain('(reddit, post)');
    expect(callArg.goal).not.toContain('(x, reply)');
    expect(callArg.goal).not.toContain('(x, post)');
  });

  it('skips reply spawn when repliesPerDay is 0 (e.g. shadowban-prone Reddit)', async () => {
    setupHappyPath({
      channels: ['x', 'reddit'],
      pathRow: {
        id: 'path-4',
        thesisArc: [
          {
            weekStart: '2026-05-04',
            theme: 't1',
            angleMix: ['claim'],
            posts: { x: 2, reddit: 3 },
          },
        ],
        channelMix: {
          x: { repliesPerDay: 5, preferredHours: [14] },
          // Reddit has posts but no replies — common to avoid shadowbans.
          reddit: { repliesPerDay: 0, preferredHours: [15] },
        },
      },
    });

    await ensureKickoffEnqueued({
      userId: 'u1',
      productId: 'p1',
      teamId: 't1',
    });

    const callArg = dispatchLeadMessageMock.mock.calls[0]![0];
    expect(callArg.goal).toContain('(x, reply)');
    expect(callArg.goal).toContain('(x, post)');
    expect(callArg.goal).toContain('(reddit, post)');
    // Reddit reply spawn omitted.
    expect(callArg.goal).not.toContain('(reddit, reply)');
  });

  it('emits a minimal goal when no strategic path exists', async () => {
    setupHappyPath({ channels: ['x'], pathRow: null });

    await ensureKickoffEnqueued({
      userId: 'u1',
      productId: 'p1',
      teamId: 't1',
    });

    const callArg = dispatchLeadMessageMock.mock.calls[0]![0];
    expect(callArg.goal).toContain('No active strategic path');
    expect(callArg.goal).not.toContain('Task(');
    expect(callArg.goal).not.toContain('add_plan_item');
  });

  it('kickoff dispatches with a publicSummary that excludes architecture details', async () => {
    setupHappyPath({
      channels: ['x'],
      productName: 'Acme',
    });

    await ensureKickoffEnqueued({
      userId: 'u1',
      productId: 'p1',
      teamId: 't1',
    });

    expect(dispatchLeadMessageMock).toHaveBeenCalledTimes(1);
    const callArg = dispatchLeadMessageMock.mock.calls[0]![0];

    // Raw goal is preserved (worker reads this for agent replay).
    expect(callArg.goal).toContain("subagent_type: 'social-media-manager'");
    expect(callArg.goal).toContain('Trigger: kickoff');

    // publicSummary is set and is a string.
    expect(typeof callArg.publicSummary).toBe('string');
    const publicSummary = callArg.publicSummary as string;

    // Founder-friendly: mentions the product name.
    expect(publicSummary).toContain('Acme');

    // Excludes internal architecture details.
    expect(publicSummary).not.toContain('social-media-manager');
    expect(publicSummary).not.toContain('Task(');
    expect(publicSummary).not.toContain('subagent_type');
    expect(publicSummary).not.toContain('add_plan_item');
    expect(publicSummary).not.toContain('Mode:');
  });

  it('returns no_coordinator when team has no coordinator member', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([]));
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([{ name: 'Shipflare' }]),
    );
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([{ id: 'm-other', agentType: 'social-media-manager' }]),
    );

    const result = await ensureKickoffEnqueued({
      userId: 'u1',
      productId: 'p1',
      teamId: 't1',
    });

    expect(result.fired).toBe(false);
    expect(result.reason).toBe('no_coordinator');
    expect(dispatchLeadMessageMock).not.toHaveBeenCalled();
  });

  it('returns no_product when product row is missing', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([]));
    dbSelectMock.mockReturnValueOnce(buildSelectChain([])); // no product

    const result = await ensureKickoffEnqueued({
      userId: 'u1',
      productId: 'missing',
      teamId: 't1',
    });

    expect(result.fired).toBe(false);
    expect(result.reason).toBe('no_product');
    expect(dispatchLeadMessageMock).not.toHaveBeenCalled();
  });
});

describe('buildKickoffGoalText (pure)', () => {
  it('handles a connected, fully-budgeted single-channel path', () => {
    const goal = buildKickoffGoalText({
      productName: 'Acme',
      pathId: 'path-x',
      weekStart: '2026-05-04T00:00:00.000Z',
      now: '2026-05-07T12:00:00.000Z',
      channels: ['x'],
      week1Posts: { x: 2, reddit: 0, email: 0 },
      channelMix: {
        x: { repliesPerDay: 5 },
      },
    });
    expect(goal).toContain('Acme');
    expect(goal).toContain('weekStart=2026-05-04T00:00:00.000Z');
    expect(goal).toContain('now=2026-05-07T12:00:00.000Z');
    expect(goal).toContain('pathId=path-x');
    expect(goal).toContain('(x, reply)');
    expect(goal).toContain('(x, post)');
    expect(goal).not.toContain('(reddit,');
  });

  it('returns a fallback goal when pathId is null', () => {
    const goal = buildKickoffGoalText({
      productName: 'Acme',
      pathId: null,
      weekStart: '2026-05-04T00:00:00.000Z',
      now: '2026-05-07T12:00:00.000Z',
      channels: ['x'],
      week1Posts: null,
      channelMix: null,
    });
    expect(goal).toContain('No active strategic path');
    expect(goal).not.toContain('Task(');
    expect(goal).not.toContain('add_plan_item');
  });

  it('treats non-numeric or negative repliesPerDay as 0', () => {
    const goal = buildKickoffGoalText({
      productName: 'Acme',
      pathId: 'path-x',
      weekStart: '2026-05-04T00:00:00.000Z',
      now: '2026-05-07T12:00:00.000Z',
      channels: ['x'],
      week1Posts: { x: 0, reddit: 0, email: 0 },
      channelMix: {
        x: { repliesPerDay: -3 },
      },
    });
    expect(goal).not.toContain('(x, reply)');
    expect(goal).not.toContain('(x, post)');
    expect(goal).toContain('No connected channels with active reply or post budget');
  });
});
