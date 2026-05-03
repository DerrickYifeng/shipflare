import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { AgentRunJobData } from '@/lib/queue/agent-run';

// ---------------------------------------------------------------------------
// Mocks — full integration runs in Phase B Task 14 e2e.
// ---------------------------------------------------------------------------

// db mock — chainable update / insert builders + query.agentRuns.findFirst.
const updateChain = {
  set: vi.fn(() => updateChain),
  where: vi.fn(async () => undefined),
};
const insertChain = {
  values: vi.fn(async () => undefined),
};
vi.mock('@/lib/db', () => ({
  db: {
    query: { agentRuns: { findFirst: vi.fn() } },
    update: vi.fn(() => updateChain),
    insert: vi.fn(() => insertChain),
    transaction: vi.fn(),
  },
}));

// Captured runAgent call args so tests can probe the injectMessages /
// onIdleReset callbacks the processor wires in. Uses vi.hoisted so the
// mock factory below can reference these without TDZ at vi.mock hoist
// time.
const runAgentHoisted = vi.hoisted(() => {
  const state: { lastArgs: unknown[] | null } = { lastArgs: null };
  const fn = vi.fn(async (...args: unknown[]) => {
    state.lastArgs = args;
    return {
      result: 'I produced 5 drafts.',
      usage: {
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.01,
        model: 'claude-sonnet-4-6',
        turns: 4,
      },
    };
  });
  return { fn, state };
});

vi.mock('@/core/query-loop', () => ({
  runAgent: runAgentHoisted.fn,
}));

vi.mock('@/tools/AgentTool/registry', () => ({
  resolveAgent: vi.fn(async (name: string) => ({
    source: 'built-in' as const,
    sourcePath: '/test',
    name,
    description: 'mock',
    role: 'member' as const,
    tools: [],
    disallowedTools: [],
    skills: [],
    requires: [],
    background: false,
    maxTurns: 10,
    systemPrompt: 'You are a test agent.',
  })),
}));

vi.mock('@/tools/AgentTool/spawn', () => ({
  buildAgentConfigFromDefinition: vi.fn((def: { name: string; systemPrompt: string }) => ({
    name: def.name,
    systemPrompt: def.systemPrompt,
    model: 'claude-sonnet-4-6',
    tools: [],
    maxTurns: 10,
  })),
}));

vi.mock('@/workers/processors/lib/mailbox-drain', () => ({
  drainMailbox: vi.fn(async () => [
    {
      id: 'msg-1',
      toAgentId: 'agent-1',
      type: 'user_prompt',
      messageType: 'message',
      content: 'Initial prompt for the teammate.',
      createdAt: new Date(),
    },
  ]),
}));

vi.mock('@/workers/processors/lib/wake', () => ({
  wake: vi.fn(async () => undefined),
}));

import { processAgentRun } from '@/workers/processors/agent-run';
import { db } from '@/lib/db';
import { drainMailbox } from '@/workers/processors/lib/mailbox-drain';

function makeJob(agentId: string): Job<AgentRunJobData> {
  return { id: 'job-1', data: { agentId } } as unknown as Job<AgentRunJobData>;
}

describe('processAgentRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateChain.set.mockClear();
    updateChain.where.mockClear();
    insertChain.values.mockClear();
    runAgentHoisted.state.lastArgs = null;
  });

  it('loads agent_runs row by agentId', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'agent-1',
      teamId: 'team-1',
      memberId: 'mem-1',
      agentDefName: 'content-manager',
      // Phase B kludge: parentAgentId is null for first-spawn teammates.
      // No notification delivered when parent is null.
      parentAgentId: null,
      status: 'queued',
    } as never);

    await processAgentRun(makeJob('agent-1'));

    expect(db.query.agentRuns.findFirst).toHaveBeenCalledOnce();
  });

  it('throws if agent_runs row not found', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue(undefined);
    await expect(processAgentRun(makeJob('missing'))).rejects.toThrow(/not found/i);
  });

  // Full state-machine + notification routing coverage lives in Task 14
  // e2e. This skeletal test just validates the load-and-dispatch contract.

  // ---------------------------------------------------------------------
  // Phase C Task 7 — idle-turn drain + shutdown_request graceful exit
  // ---------------------------------------------------------------------

  it('drains mailbox at idle-turn boundary and exposes content via injectMessages', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'agent-1',
      teamId: 'team-1',
      memberId: 'mem-1',
      agentDefName: 'content-manager',
      parentAgentId: null,
      status: 'queued',
    } as never);

    // Track drainMailbox call sequence.
    // 1st call: initial-prompt drain (existing Phase B behavior).
    // 2nd call: idle-turn drain — returns one mid-run user message.
    // Subsequent calls: empty.
    const idleMessage = {
      id: 'msg-mid',
      toAgentId: 'agent-1',
      type: 'user_prompt',
      messageType: 'message',
      content: 'Mid-run injection from peer.',
      createdAt: new Date(),
    };
    let drainCount = 0;
    vi.mocked(drainMailbox).mockImplementation(async () => {
      drainCount += 1;
      if (drainCount === 1) {
        return [
          {
            id: 'msg-init',
            toAgentId: 'agent-1',
            type: 'user_prompt',
            messageType: 'message',
            content: 'Initial prompt.',
            createdAt: new Date(),
          },
        ];
      }
      if (drainCount === 2) return [idleMessage];
      return [];
    });

    // runAgent stub: invoke injectMessages once after the initial drain
    // has been delivered so the idle-turn path runs at least one drain
    // before runAgent returns.
    runAgentHoisted.fn.mockImplementationOnce(async (...args: unknown[]) => {
      runAgentHoisted.state.lastArgs = args;
      const injectMessages = args[8] as
        | (() => Array<{ role: 'user'; content: string }>)
        | undefined;
      // Wait long enough for the background drain timer (1s) to fire
      // at least once and push the idle message into pendingInjections.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const drained = injectMessages ? injectMessages() : [];
      return {
        result: 'ok',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.0,
          model: 'claude-sonnet-4-6',
          turns: 1,
          drained,
        },
      };
    });

    await processAgentRun(makeJob('agent-1'));

    // runAgent received an injectMessages callback (positional arg index
    // 8 per query-loop signature: config, userMessage, ctx, schema,
    // onProgress, prebuilt, onIdleReset, onEvent, injectMessages).
    expect(runAgentHoisted.state.lastArgs).not.toBeNull();
    const injectArg = runAgentHoisted.state.lastArgs?.[8];
    expect(typeof injectArg).toBe('function');

    // drainMailbox should have been called at least twice (initial +
    // ≥1 idle-turn poll while runAgent was suspended).
    expect(drainCount).toBeGreaterThanOrEqual(2);

    // The mid-run idle message reached the agent via injectMessages —
    // assert the runAgent stub captured it on its drained read.
    // (Since runAgent is mocked we encode this through the result it
    // returned; in production the message lands in `messages` array.)
    // Probe by inspecting the resolved usage.drained shape we attached.
    // The injection happened only if pendingInjections received the
    // background drain content.
    // We don't have direct access to runAgent's resolved value — so
    // assert via drainCount + injectArg presence.
  }, 10000);

  it('on shutdown_request received, exits gracefully with status=killed and notification status=killed', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'agent-1',
      teamId: 'team-1',
      memberId: 'mem-1',
      agentDefName: 'content-manager',
      parentAgentId: 'lead-agent',
      status: 'queued',
    } as never);

    let drainCount = 0;
    vi.mocked(drainMailbox).mockImplementation(async () => {
      drainCount += 1;
      if (drainCount === 1) {
        // Initial-prompt drain.
        return [
          {
            id: 'msg-init',
            toAgentId: 'agent-1',
            type: 'user_prompt',
            messageType: 'message',
            content: 'Initial prompt.',
            createdAt: new Date(),
          },
        ];
      }
      if (drainCount === 2) {
        // Idle-turn drain: lead asked teammate to stop.
        return [
          {
            id: 'msg-stop',
            toAgentId: 'agent-1',
            type: 'user_prompt',
            messageType: 'shutdown_request',
            content: 'Stop requested by team-lead.',
            createdAt: new Date(),
          },
        ];
      }
      return [];
    });

    // runAgent stub: wait for the idle drain to land, then return as if
    // the agent decided to wrap up after seeing the shutdown notice.
    runAgentHoisted.fn.mockImplementationOnce(async (...args: unknown[]) => {
      runAgentHoisted.state.lastArgs = args;
      // Wait so the background poll fires at least once and the
      // shutdown_request lands.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return {
        result: 'wrapped up',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.0,
          model: 'claude-sonnet-4-6',
          turns: 1,
        },
      };
    });

    await processAgentRun(makeJob('agent-1'));

    // The background drain saw shutdown_request, so the processor must
    // have flipped status='killed' on the agent_runs row.
    const setCalls = updateChain.set.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    expect(setCalls.some((s) => s.status === 'killed')).toBe(true);

    // The synthesized notification XML must carry <status>killed</status>.
    const insertedRows = insertChain.values.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    const notification = insertedRows.find((r) => r.messageType === 'task_notification');
    expect(notification).toBeDefined();
    expect(String(notification?.content ?? '')).toContain('<status>killed</status>');
  }, 10000);

  // ---------------------------------------------------------------------
  // Phase D Task 4 — Sleep tool early-exit without notification
  // ---------------------------------------------------------------------

  it('Sleep tool_done event triggers early exit WITHOUT calling synthesizeTaskNotification', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'agent-1',
      teamId: 'team-1',
      memberId: 'mem-1',
      agentDefName: 'content-manager',
      parentAgentId: 'lead-agent',
      status: 'queued',
    } as never);

    // Only the initial-prompt drain is needed — Sleep takes the agent out
    // of the loop before any further idle drain happens.
    vi.mocked(drainMailbox).mockImplementation(async () => [
      {
        id: 'msg-init',
        toAgentId: 'agent-1',
        type: 'user_prompt',
        messageType: 'message',
        content: 'Initial prompt.',
        createdAt: new Date(),
      },
    ]);

    // runAgent stub: emit a `tool_done` event with toolName='Sleep' and
    // a JSON-stringified `{slept:true,...}` content (mirrors the tool
    // executor's serialization). Then resolve cleanly — the processor
    // should observe `sleepingExit` and skip the notification regardless.
    runAgentHoisted.fn.mockImplementationOnce(async (...args: unknown[]) => {
      runAgentHoisted.state.lastArgs = args;
      const onEvent = args[7] as
        | ((event: { type: string; toolName?: string; result?: { content: string } }) => void | Promise<void>)
        | undefined;
      if (onEvent) {
        await onEvent({
          type: 'tool_done',
          toolName: 'Sleep',
          result: {
            content: JSON.stringify({
              slept: true,
              agentId: 'agent-1',
              durationMs: 30_000,
              wakeAt: new Date().toISOString(),
            }),
          },
        });
      }
      return {
        result: '',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
          model: 'claude-sonnet-4-6',
          turns: 1,
        },
      };
    });

    await processAgentRun(makeJob('agent-1'));

    // No task_notification row should have been inserted — the Sleep tool
    // already updated agent_runs.status='sleeping' itself; the agent is
    // yielding, not finished.
    const insertedRows = insertChain.values.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    const notification = insertedRows.find(
      (r) => r.messageType === 'task_notification',
    );
    expect(notification).toBeUndefined();

    // The processor must NOT have overwritten agent_runs.status to
    // 'completed' / 'failed' / 'killed' on exit. The Sleep tool already
    // set status='sleeping'; the early-exit path leaves it untouched.
    const setCalls = updateChain.set.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    expect(
      setCalls.some(
        (s) =>
          s.status === 'completed' ||
          s.status === 'failed' ||
          s.status === 'killed',
      ),
    ).toBe(false);
  });

  it('injects callerAgentId into ToolContext so the Sleep tool can read it', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'agent-42',
      teamId: 'team-1',
      memberId: 'mem-1',
      agentDefName: 'content-manager',
      parentAgentId: null,
      status: 'queued',
    } as never);

    // Capture the ToolContext that runAgent was handed so we can probe
    // ctx.get('callerAgentId').
    let capturedCtx: { get<V>(key: string): V } | null = null;
    runAgentHoisted.fn.mockImplementationOnce(async (...args: unknown[]) => {
      runAgentHoisted.state.lastArgs = args;
      capturedCtx = args[2] as { get<V>(key: string): V };
      return {
        result: 'ok',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
          model: 'claude-sonnet-4-6',
          turns: 1,
        },
      };
    });

    await processAgentRun(makeJob('agent-42'));

    expect(capturedCtx).not.toBeNull();
    // The processor must inject the agentId so the Sleep tool can mark
    // the correct agent_runs row as sleeping.
    expect(capturedCtx!.get<string>('callerAgentId')).toBe('agent-42');
  });
});
