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

vi.mock('@/lib/queue/team-run', () => ({
  enqueueTeamRun: vi.fn(),
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
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { createAutomationConversation } from '@/lib/team-conversation-helpers';

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
  });

  it('skips when a kickoff run already exists for the team', async () => {
    // First select() → existing kickoff run.
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ id: 'run-1' }]));

    const result = await ensureKickoffEnqueued({
      userId: 'u1',
      productId: 'p1',
      teamId: 't1',
    });

    expect(result.fired).toBe(false);
    expect(result.reason).toBe('already_kickoffed');
    expect(enqueueTeamRun).not.toHaveBeenCalled();
    expect(createAutomationConversation).not.toHaveBeenCalled();
  });

  it('enqueues when no kickoff run exists', async () => {
    // 1. team_runs lookup → empty (no past kickoff).
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

    vi.mocked(enqueueTeamRun).mockResolvedValueOnce({
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
    expect(enqueueTeamRun).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(enqueueTeamRun).mock.calls[0]![0];
    expect(callArg.trigger).toBe('kickoff');
    expect(callArg.rootMemberId).toBe('m-coord');
    expect(callArg.conversationId).toBe('conv-1');
    expect(callArg.goal).toContain('weekStart=');
    expect(callArg.goal).toContain('now=');
    expect(callArg.goal).toContain('pathId=path-1');
    // New playbook: plan → discovery → drafts.
    expect(callArg.goal).toContain('content-planner');
    expect(callArg.goal).toContain("subagent_type: 'discovery-agent'");
    expect(callArg.goal).toContain('content-manager');
    // Calibration / scout / reviewer / inline-mode references are gone.
    expect(callArg.goal).not.toContain('calibrate_search_strategy');
    expect(callArg.goal).not.toContain('run_discovery_scan');
    expect(callArg.goal).not.toContain('inlineQueryCount');
    expect(callArg.goal).not.toContain('discovery-scout');
    // No-channels skip preserved.
    expect(callArg.goal).toContain('Skip steps 2-3 if no channels');
    // Order: discovery-agent appears before content-manager.
    const goal: string = callArg.goal;
    const discoveryIdx = goal.indexOf("subagent_type: 'discovery-agent'");
    const draftsIdx = goal.indexOf('content-manager');
    expect(discoveryIdx).toBeGreaterThan(0);
    expect(draftsIdx).toBeGreaterThan(discoveryIdx);
  });

  it('returns no_coordinator when team has no coordinator member', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([]));
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([{ name: 'Shipflare' }]),
    );
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([{ id: 'm-other', agentType: 'content-planner' }]),
    );

    const result = await ensureKickoffEnqueued({
      userId: 'u1',
      productId: 'p1',
      teamId: 't1',
    });

    expect(result.fired).toBe(false);
    expect(result.reason).toBe('no_coordinator');
    expect(enqueueTeamRun).not.toHaveBeenCalled();
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
    expect(enqueueTeamRun).not.toHaveBeenCalled();
  });
});
