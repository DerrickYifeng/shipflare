import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbSelectMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => dbSelectMock(...args),
  },
}));

vi.mock('@/lib/user-channels', () => ({
  getUserChannels: vi.fn().mockResolvedValue(['x']),
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

vi.mock('@/lib/onboarding-run-finalizer', () => ({
  finalizePendingOnboardingRuns: vi
    .fn()
    .mockResolvedValue({ finalized: 0, runIds: [] }),
}));

import { ensureKickoffEnqueued } from '../team-kickoff';
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

describe('ensureKickoffEnqueued', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.mockReset();
    dispatchLeadMessageMock.mockReset();
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

  it('dispatches when no kickoff message exists', async () => {
    // 1. team_messages lookup → empty (no past kickoff).
    dbSelectMock.mockReturnValueOnce(buildSelectChain([]));
    // 2. products lookup.
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([{ name: 'Shipflare' }]),
    );
    // 3. team_members lookup → coordinator present.
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([
        { id: 'm-coord', agentType: 'coordinator' },
        { id: 'm-other', agentType: 'content-planner' },
      ]),
    );
    // 4. strategic_paths lookup — non-empty so the goal carries pathId.
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ id: 'path-1' }]));

    dispatchLeadMessageMock.mockResolvedValueOnce({
      runId: 'run-new',
      traceId: 'trace-1',
      alreadyRunning: false,
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
    expect(callArg.goal).toContain('weekStart=');
    expect(callArg.goal).toContain('now=');
    expect(callArg.goal).toContain('pathId=path-1');
    // Plan 3 playbook: coordinator generates plan items directly +
    // dispatches a single social-media-manager spawn that does
    // discovery + judging + drafting internally.
    expect(callArg.goal).toContain('add_plan_item');
    expect(callArg.goal).toContain("subagent_type: 'social-media-manager'");
    expect(callArg.goal).toContain('discover-and-fill-slot');
    // Calibration / scout / reviewer / inline-mode references are gone.
    expect(callArg.goal).not.toContain('calibrate_search_strategy');
    expect(callArg.goal).not.toContain('run_discovery_scan');
    expect(callArg.goal).not.toContain('inlineQueryCount');
    expect(callArg.goal).not.toContain('discovery-scout');
    // Legacy specialist agent names are gone (Plan 3 collapse).
    expect(callArg.goal).not.toContain('content-planner');
    expect(callArg.goal).not.toContain('discovery-agent');
    expect(callArg.goal).not.toContain('content-manager');
    // No-channels skip preserved.
    expect(callArg.goal).toContain('Skip steps 2-3 if no channels');
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
