import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbSelectMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => dbSelectMock(...args),
  },
}));

vi.mock('@/lib/team/dispatch-lead-message', () => ({
  dispatchLeadMessage: vi.fn(),
}));

vi.mock('@/lib/team-rolling-conversation', () => ({
  resolveRollingConversation: vi.fn().mockResolvedValue('conv-daily'),
}));

import {
  ensureDailyRunEnqueued,
  buildDailyGoalText,
} from '../team-daily-run';
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
 * Daily-run does 2 sequential SELECTs:
 *   1. products lookup
 *   2. strategic_paths lookup (for channelMix → repliesPerDay)
 */
function setupHappyPath(opts?: {
  productName?: string;
  pathRow?: Record<string, unknown> | null;
}): void {
  const productName = opts?.productName ?? 'Shipflare';
  const pathRow =
    opts?.pathRow === null
      ? null
      : opts?.pathRow ?? {
          id: 'path-1',
          channelMix: {
            x: { repliesPerDay: 5, preferredHours: [14] },
            reddit: { repliesPerDay: 2, preferredHours: [15] },
          },
        };

  // 1. products lookup.
  dbSelectMock.mockReturnValueOnce(buildSelectChain([{ name: productName }]));
  // 2. strategic_paths lookup.
  dbSelectMock.mockReturnValueOnce(buildSelectChain(pathRow ? [pathRow] : []));

  dispatchLeadMessageMock.mockResolvedValueOnce({
    runId: 'run-daily',
    traceId: 'trace-daily',
    alreadyRunning: false,
  });
}

describe('ensureDailyRunEnqueued', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.mockReset();
    dispatchLeadMessageMock.mockReset();
  });

  it('returns no_product when product row is missing', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([])); // no product

    const result = await ensureDailyRunEnqueued({
      userId: 'u1',
      productId: 'missing',
      teamId: 't1',
      platforms: ['x'],
    });

    expect(result.fired).toBe(false);
    expect(result.reason).toBe('no_product');
    expect(dispatchLeadMessageMock).not.toHaveBeenCalled();
  });

  it('emits a daily goal with explicit (channel × mode) parallel spawn directives', async () => {
    setupHappyPath({
      pathRow: {
        id: 'path-x',
        channelMix: {
          x: { repliesPerDay: 5, preferredHours: [14] },
          reddit: { repliesPerDay: 2, preferredHours: [15] },
        },
      },
    });

    const result = await ensureDailyRunEnqueued({
      userId: 'u1',
      productId: 'p1',
      teamId: 't1',
      platforms: ['x', 'reddit'],
      source: 'cron',
    });

    expect(result.fired).toBe(true);
    expect(result.runId).toBe('run-daily');
    expect(result.conversationId).toBe('conv-daily');
    expect(dispatchLeadMessageMock).toHaveBeenCalledTimes(1);

    const callArg = dispatchLeadMessageMock.mock.calls[0]![0];
    expect(callArg.trigger).toBe('daily');

    // Trigger + source attribution preserved.
    expect(callArg.goal).toContain('Trigger: daily');
    expect(callArg.goal).toContain('Source: cron');

    // Daily must NOT instruct add_plan_item — kickoff + weekly own seeding.
    expect(callArg.goal).not.toContain('add_plan_item');

    // Both channels appear with explicit parallel spawn directives.
    expect(callArg.goal).toContain('(x, reply)');
    expect(callArg.goal).toContain('(reddit, reply)');
    expect(callArg.goal).toContain('(x, post)');
    expect(callArg.goal).toContain('(reddit, post)');

    // targetCount carried from channelMix.
    expect(callArg.goal).toContain('targetCount: 5');
    expect(callArg.goal).toContain('targetCount: 2');

    // Parallel-spawn directive present.
    expect(callArg.goal).toContain('SINGLE ASSISTANT TURN');

    // Update directive present.
    expect(callArg.goal).toContain('update_plan_item');

    // Legacy specialist agent names are gone.
    expect(callArg.goal).not.toContain('content-planner');
    expect(callArg.goal).not.toContain('discovery-agent');
    expect(callArg.goal).not.toContain('content-manager');
  });

  it('emits 2 directives for a Reddit-only setup', async () => {
    setupHappyPath({
      pathRow: {
        id: 'path-r',
        channelMix: {
          reddit: { repliesPerDay: 2, preferredHours: [15] },
        },
      },
    });

    await ensureDailyRunEnqueued({
      userId: 'u1',
      productId: 'p1',
      teamId: 't1',
      platforms: ['reddit'],
      source: 'cron',
    });

    const callArg = dispatchLeadMessageMock.mock.calls[0]![0];
    expect(callArg.goal).toContain('(reddit, reply)');
    expect(callArg.goal).toContain('(reddit, post)');
    expect(callArg.goal).not.toContain('(x, reply)');
    expect(callArg.goal).not.toContain('(x, post)');
  });

  it('skips reply spawn when repliesPerDay is 0', async () => {
    setupHappyPath({
      pathRow: {
        id: 'path-r',
        channelMix: {
          x: { repliesPerDay: 5, preferredHours: [14] },
          reddit: { repliesPerDay: 0, preferredHours: [15] },
        },
      },
    });

    await ensureDailyRunEnqueued({
      userId: 'u1',
      productId: 'p1',
      teamId: 't1',
      platforms: ['x', 'reddit'],
      source: 'cron',
    });

    const callArg = dispatchLeadMessageMock.mock.calls[0]![0];
    expect(callArg.goal).toContain('(x, reply)');
    expect(callArg.goal).not.toContain('(reddit, reply)');
    // Post spawn is still emitted (it's gated on slot existence, not budget).
    expect(callArg.goal).toContain('(reddit, post)');
  });

  it('emits a "no budget" message when no channels are connected', async () => {
    setupHappyPath({ pathRow: null });

    await ensureDailyRunEnqueued({
      userId: 'u1',
      productId: 'p1',
      teamId: 't1',
      platforms: [],
    });

    const callArg = dispatchLeadMessageMock.mock.calls[0]![0];
    expect(callArg.goal).toContain('No connected channels with active reply or post budget');
    expect(callArg.goal).not.toContain('Task(');
  });
});

describe('buildDailyGoalText (pure)', () => {
  it('emits 4 (channel × mode) lines when both channels are budgeted', () => {
    const goal = buildDailyGoalText({
      productName: 'Acme',
      platforms: ['x', 'reddit'],
      source: 'cron',
      channelMix: {
        x: { repliesPerDay: 5 },
        reddit: { repliesPerDay: 2 },
      },
    });
    expect(goal).toContain('Trigger: daily');
    expect(goal).toContain('Source: cron');
    expect(goal).toContain('(x, reply)');
    expect(goal).toContain('(reddit, reply)');
    expect(goal).toContain('(x, post)');
    expect(goal).toContain('(reddit, post)');
    expect(goal).toContain('targetCount: 5');
    expect(goal).toContain('targetCount: 2');
    // Daily MUST NOT seed plan_items.
    expect(goal).not.toContain('add_plan_item');
  });

  it('omits source clause when none is provided', () => {
    const goal = buildDailyGoalText({
      productName: 'Acme',
      platforms: ['x'],
      channelMix: {
        x: { repliesPerDay: 5 },
      },
    });
    expect(goal).toContain('Trigger: daily.');
    expect(goal).not.toContain('Source:');
  });
});
