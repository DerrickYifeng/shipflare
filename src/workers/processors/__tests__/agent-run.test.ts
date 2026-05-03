import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { AgentRunJobData } from '@/lib/queue/agent-run';

// ---------------------------------------------------------------------------
// Mocks — full integration runs in Phase B Task 14 e2e.
// ---------------------------------------------------------------------------

// db mock — chainable update / insert / select builders + query.agentRuns.findFirst.
//
// The select chain backs `resolvePrimaryConversation`'s
// `db.select({id}).from(teamConversations).where(...).orderBy(...).limit(1)`.
// Tests can rebind `selectChain.limit` per case to return whichever rows
// they want (most cases want either zero rows or a single conversation id).
const updateChain = {
  set: vi.fn(() => updateChain),
  where: vi.fn(async () => undefined),
};
const insertChain = {
  values: vi.fn(async () => undefined),
};
const selectChain: {
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
} = {
  from: vi.fn(() => selectChain),
  where: vi.fn(() => selectChain),
  orderBy: vi.fn(() => selectChain),
  // Default: no team_conversations row exists — lead falls back to
  // running without priorMessages. Individual tests can override.
  limit: vi.fn(async () => []),
};
vi.mock('@/lib/db', () => ({
  db: {
    query: { agentRuns: { findFirst: vi.fn() } },
    update: vi.fn(() => updateChain),
    insert: vi.fn(() => insertChain),
    select: vi.fn(() => selectChain),
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

vi.mock('@/workers/processors/lib/agent-run-history', () => ({
  loadAgentRunHistory: vi.fn(async () => []),
}));

vi.mock('@/lib/team-conversation', () => ({
  loadConversationHistory: vi.fn(async () => []),
}));

// Phase E Task 6: SSE publisher — tests assert publish is called for the
// lead's assistant turns and skipped for teammates'.
const publishMock = vi.hoisted(() =>
  vi.fn(async (_channel: string, _payload: string) => 1),
);
vi.mock('@/lib/redis', () => ({
  getPubSubPublisher: () => ({ publish: publishMock }),
}));

import { processAgentRun } from '@/workers/processors/agent-run';
import { db } from '@/lib/db';
import { drainMailbox } from '@/workers/processors/lib/mailbox-drain';
import { loadAgentRunHistory } from '@/workers/processors/lib/agent-run-history';
import { loadConversationHistory } from '@/lib/team-conversation';
import { resolveAgent } from '@/tools/AgentTool/registry';
import { teamMessagesChannel } from '@/tools/SendMessageTool/SendMessageTool';

function makeJob(agentId: string): Job<AgentRunJobData> {
  return { id: 'job-1', data: { agentId } } as unknown as Job<AgentRunJobData>;
}

describe('processAgentRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateChain.set.mockClear();
    updateChain.where.mockClear();
    insertChain.values.mockClear();
    selectChain.from.mockClear();
    selectChain.where.mockClear();
    selectChain.orderBy.mockClear();
    selectChain.limit.mockReset();
    // Reset to default chain behavior after mockReset wiped the impl.
    selectChain.from.mockReturnValue(selectChain);
    selectChain.where.mockReturnValue(selectChain);
    selectChain.orderBy.mockReturnValue(selectChain);
    selectChain.limit.mockResolvedValue([]);
    runAgentHoisted.state.lastArgs = null;
    publishMock.mockClear();
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

  // ---------------------------------------------------------------------
  // Phase D Task 5 — Resume from sleeping + per-turn persistence
  // ---------------------------------------------------------------------

  it('on resume from status=sleeping, loads history via loadAgentRunHistory and passes it as priorMessages to runAgent', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'agent-resume',
      teamId: 'team-1',
      memberId: 'mem-1',
      agentDefName: 'content-manager',
      parentAgentId: null,
      status: 'sleeping',
    } as never);

    const priorTurns = [
      { role: 'user' as const, content: 'initial prompt' },
      { role: 'assistant' as const, content: 'I will help' },
    ];
    vi.mocked(loadAgentRunHistory).mockResolvedValueOnce(priorTurns);

    await processAgentRun(makeJob('agent-resume'));

    // History was loaded with the resuming agent's id.
    expect(loadAgentRunHistory).toHaveBeenCalledOnce();
    expect(vi.mocked(loadAgentRunHistory).mock.calls[0][0]).toBe('agent-resume');

    // runAgent received priorMessages at positional arg 9
    // (config, userMessage, ctx, schema, onProgress, prebuilt, onIdleReset,
    //  onEvent, injectMessages, priorMessages).
    expect(runAgentHoisted.state.lastArgs).not.toBeNull();
    expect(runAgentHoisted.state.lastArgs?.[9]).toEqual(priorTurns);

    // The processor walked the row through resuming → running before
    // calling runAgent.
    const setCalls = updateChain.set.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    expect(setCalls.some((s) => s.status === 'resuming')).toBe(true);
    expect(setCalls.some((s) => s.status === 'running')).toBe(true);
  });

  it('does NOT load history or set status=resuming when starting from status=queued', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'agent-fresh',
      teamId: 'team-1',
      memberId: 'mem-1',
      agentDefName: 'content-manager',
      parentAgentId: null,
      status: 'queued',
    } as never);

    await processAgentRun(makeJob('agent-fresh'));

    expect(loadAgentRunHistory).not.toHaveBeenCalled();
    // priorMessages slot must be undefined (no resume).
    expect(runAgentHoisted.state.lastArgs?.[9]).toBeUndefined();
    const setCalls = updateChain.set.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    expect(setCalls.some((s) => s.status === 'resuming')).toBe(false);
  });

  it('persists each assistant turn to team_messages so the next resume sees it (fromAgentId=self, type=agent_text, deliveredAt set)', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'agent-persist',
      teamId: 'team-77',
      memberId: 'mem-9',
      agentDefName: 'content-manager',
      parentAgentId: 'lead-agent',
      status: 'queued',
    } as never);

    // runAgent stub: emit two completed assistant text blocks before
    // returning. `assistant_text_stop` is the per-turn-text completion
    // event — see src/core/types.ts and src/core/query-loop.ts.
    runAgentHoisted.fn.mockImplementationOnce(async (...args: unknown[]) => {
      runAgentHoisted.state.lastArgs = args;
      const onEvent = args[7] as
        | ((event: {
            type: string;
            messageId?: string;
            turn?: number;
            blockIndex?: number;
            text?: string;
          }) => void | Promise<void>)
        | undefined;
      if (onEvent) {
        await onEvent({
          type: 'assistant_text_stop',
          messageId: 'm1',
          turn: 1,
          blockIndex: 0,
          text: 'turn 1 reply',
        });
        await onEvent({
          type: 'assistant_text_stop',
          messageId: 'm2',
          turn: 2,
          blockIndex: 0,
          text: 'turn 2 reply',
        });
      }
      return {
        result: 'final answer',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
          model: 'claude-sonnet-4-6',
          turns: 2,
        },
      };
    });

    await processAgentRun(makeJob('agent-persist'));

    const insertedRows = insertChain.values.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );

    // Both assistant turns should be persisted with the agent as sender,
    // type='agent_text', and deliveredAt set so loadAgentRunHistory sees
    // them on next resume.
    const turnRows = insertedRows.filter(
      (r) => r.type === 'agent_text' && r.fromAgentId === 'agent-persist',
    );
    expect(turnRows).toHaveLength(2);
    expect(turnRows[0]).toMatchObject({
      teamId: 'team-77',
      type: 'agent_text',
      fromAgentId: 'agent-persist',
      content: 'turn 1 reply',
    });
    expect(turnRows[0].deliveredAt).toBeInstanceOf(Date);
    expect(turnRows[1]).toMatchObject({
      type: 'agent_text',
      fromAgentId: 'agent-persist',
      content: 'turn 2 reply',
    });
    expect(turnRows[1].deliveredAt).toBeInstanceOf(Date);

    // Final task_notification still goes through (this is a normal
    // completion run, not a Sleep yield).
    const notification = insertedRows.find(
      (r) => r.messageType === 'task_notification',
    );
    expect(notification).toBeDefined();
  });

  // ---------------------------------------------------------------------
  // Phase E Task 4 — lead init: load conversation history
  // ---------------------------------------------------------------------

  it('lead agent loads conversation history via loadConversationHistory and passes it as priorMessages to runAgent', async () => {
    // Lead row — fresh queued, no parent (lead is the root).
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'lead-1',
      teamId: 'team-lead',
      memberId: 'mem-lead',
      agentDefName: 'coordinator',
      parentAgentId: null,
      status: 'queued',
    } as never);

    // Flag this agent as the team-lead so the Phase E branch fires.
    vi.mocked(resolveAgent).mockResolvedValueOnce({
      source: 'built-in',
      sourcePath: '/test',
      name: 'coordinator',
      description: 'mock lead',
      role: 'lead',
      tools: [],
      disallowedTools: [],
      skills: [],
      requires: [],
      background: false,
      maxTurns: 10,
      systemPrompt: 'You are the team lead.',
    } as never);

    // resolvePrimaryConversation: select(...).from(...).where(...).orderBy(...).limit(1)
    // Return one row → lead has a primary conversation to load from.
    selectChain.limit.mockResolvedValueOnce([{ id: 'conv-primary' }]);

    const priorTurns = [
      { role: 'user' as const, content: 'previous chat msg 1' },
      { role: 'assistant' as const, content: 'previous reply' },
    ];
    vi.mocked(loadConversationHistory).mockResolvedValueOnce(priorTurns);

    await processAgentRun(makeJob('lead-1'));

    // Lead consulted team_conversations for its primary thread id and
    // then loaded history scoped to that conversation.
    expect(loadConversationHistory).toHaveBeenCalledOnce();
    const [teamIdArg, optsArg] = vi.mocked(loadConversationHistory).mock.calls[0];
    expect(teamIdArg).toBe('team-lead');
    expect(optsArg).toMatchObject({ conversationId: 'conv-primary' });

    // Phase D's per-agent transcript loader must NOT run for the lead —
    // lead history lives in team_messages keyed by conversation, not by
    // agent_runs row.
    expect(loadAgentRunHistory).not.toHaveBeenCalled();

    // priorMessages lands at runAgent positional arg 9
    // (config, userMessage, ctx, schema, onProgress, prebuilt, onIdleReset,
    //  onEvent, injectMessages, priorMessages).
    expect(runAgentHoisted.state.lastArgs).not.toBeNull();
    expect(runAgentHoisted.state.lastArgs?.[9]).toEqual(priorTurns);

    // Lead path skips the resuming dance — it's a fresh BullMQ job, not
    // a wake-from-sleep.
    const setCalls = updateChain.set.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    expect(setCalls.some((s) => s.status === 'resuming')).toBe(false);
    expect(setCalls.some((s) => s.status === 'running')).toBe(true);
  });

  it('non-lead agent (Phase D resume from sleeping) keeps the loadAgentRunHistory path unchanged', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'agent-non-lead-resume',
      teamId: 'team-1',
      memberId: 'mem-1',
      agentDefName: 'content-manager',
      parentAgentId: 'lead-agent',
      status: 'sleeping',
    } as never);

    // Default resolveAgent returns role='member' — non-lead path.
    const priorTurns = [
      { role: 'user' as const, content: 'agent-scoped resume turn' },
    ];
    vi.mocked(loadAgentRunHistory).mockResolvedValueOnce(priorTurns);

    await processAgentRun(makeJob('agent-non-lead-resume'));

    // Phase E's lead loader must NOT run for a non-lead agent.
    expect(loadConversationHistory).not.toHaveBeenCalled();

    // Phase D path runs — agent-scoped history, with the resuming → running
    // status hop preserved.
    expect(loadAgentRunHistory).toHaveBeenCalledOnce();
    expect(vi.mocked(loadAgentRunHistory).mock.calls[0][0]).toBe(
      'agent-non-lead-resume',
    );
    expect(runAgentHoisted.state.lastArgs?.[9]).toEqual(priorTurns);

    const setCalls = updateChain.set.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    expect(setCalls.some((s) => s.status === 'resuming')).toBe(true);
    expect(setCalls.some((s) => s.status === 'running')).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Phase E Task 6 — lead SSE publish on assistant_text_stop
  // ---------------------------------------------------------------------

  it('lead agent publishes assistant turns to the team SSE channel', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'lead-sse',
      teamId: 'team-sse',
      memberId: 'mem-sse',
      agentDefName: 'coordinator',
      parentAgentId: null,
      status: 'queued',
    } as never);

    // Flag the agent as the team-lead so Phase E SSE path fires.
    vi.mocked(resolveAgent).mockResolvedValueOnce({
      source: 'built-in',
      sourcePath: '/test',
      name: 'coordinator',
      description: 'mock lead',
      role: 'lead',
      tools: [],
      disallowedTools: [],
      skills: [],
      requires: [],
      background: false,
      maxTurns: 10,
      systemPrompt: 'You are the team lead.',
    } as never);

    // Fresh lead — no prior team_conversations row, so priorMessages stays
    // undefined and the lead just runs.
    selectChain.limit.mockResolvedValueOnce([]);

    runAgentHoisted.fn.mockImplementationOnce(async (...args: unknown[]) => {
      runAgentHoisted.state.lastArgs = args;
      const onEvent = args[7] as
        | ((event: {
            type: string;
            messageId?: string;
            turn?: number;
            blockIndex?: number;
            text?: string;
          }) => void | Promise<void>)
        | undefined;
      if (onEvent) {
        await onEvent({
          type: 'assistant_text_stop',
          messageId: 'm-lead-1',
          turn: 1,
          blockIndex: 0,
          text: 'lead reply visible to founder',
        });
      }
      return {
        result: 'final lead answer',
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

    await processAgentRun(makeJob('lead-sse'));

    // SSE publish must have fired with the team-messages channel and a
    // payload echoing the assistant text.
    expect(publishMock).toHaveBeenCalled();
    const sseCall = publishMock.mock.calls.find(
      ([channel]) => channel === teamMessagesChannel('team-sse'),
    );
    expect(sseCall).toBeDefined();
    const payload = JSON.parse(sseCall![1]);
    expect(payload).toMatchObject({
      teamId: 'team-sse',
      type: 'agent_text',
      content: 'lead reply visible to founder',
      fromAgentId: 'lead-sse',
    });
    expect(typeof payload.messageId).toBe('string');
    expect(payload.messageId.length).toBeGreaterThan(0);

    // The durable team_messages row must use the SAME id the SSE payload
    // referenced — the client matches them so an in-flight optimistic
    // bubble swaps into the persisted row in place.
    const insertedRows = insertChain.values.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    const turnRow = insertedRows.find(
      (r) =>
        r.type === 'agent_text' &&
        r.fromAgentId === 'lead-sse' &&
        r.content === 'lead reply visible to founder',
    );
    expect(turnRow).toBeDefined();
    expect(turnRow!.id).toBe(payload.messageId);
  });

  it('non-lead agent does NOT publish assistant turns to the SSE channel', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'agent-no-sse',
      teamId: 'team-quiet',
      memberId: 'mem-quiet',
      agentDefName: 'content-manager',
      parentAgentId: 'lead-agent',
      status: 'queued',
    } as never);

    // Default resolveAgent mock returns role='member' — the non-lead path.
    runAgentHoisted.fn.mockImplementationOnce(async (...args: unknown[]) => {
      runAgentHoisted.state.lastArgs = args;
      const onEvent = args[7] as
        | ((event: {
            type: string;
            messageId?: string;
            turn?: number;
            blockIndex?: number;
            text?: string;
          }) => void | Promise<void>)
        | undefined;
      if (onEvent) {
        await onEvent({
          type: 'assistant_text_stop',
          messageId: 'm-teammate-1',
          turn: 1,
          blockIndex: 0,
          text: 'teammate inner thought',
        });
      }
      return {
        result: 'teammate done',
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

    await processAgentRun(makeJob('agent-no-sse'));

    // No publish to the team-messages SSE channel — teammate output reaches
    // the lead via task_notification mailbox routing, not the live stream.
    const sseCall = publishMock.mock.calls.find(
      ([channel]) => channel === teamMessagesChannel('team-quiet'),
    );
    expect(sseCall).toBeUndefined();

    // Sanity: the durable per-turn row still landed (Phase D persistence
    // is independent of the lead-only SSE branch).
    const insertedRows = insertChain.values.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    const turnRow = insertedRows.find(
      (r) =>
        r.type === 'agent_text' &&
        r.fromAgentId === 'agent-no-sse' &&
        r.content === 'teammate inner thought',
    );
    expect(turnRow).toBeDefined();
  });

  // ---------------------------------------------------------------------
  // Phase E hot-fix — working-indicator gap
  //
  // Phase E Task 11 deleted team-run.ts which used to:
  //   (a) stamp conversationId on the lead's outgoing message rows, and
  //   (b) publish a terminal 'completion'/'error' SSE event when the run
  //       finished.
  // Without (a) the founder UI's per-thread filter dropped every reply
  // bubble; without (b) the typing indicator stayed pinned on
  // "working..." even after the agent reported end_turn. Both are
  // reinstated in agent-run.ts; these tests guard the wiring so a
  // future cleanup pass can't silently regress them.
  // ---------------------------------------------------------------------

  it('lead persists agent_text rows with conversationId AND publishes SSE with conversationId + runId', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'lead-stamp',
      teamId: 'team-stamp',
      memberId: 'mem-stamp',
      agentDefName: 'coordinator',
      parentAgentId: null,
      status: 'queued',
    } as never);

    vi.mocked(resolveAgent).mockResolvedValueOnce({
      source: 'built-in',
      sourcePath: '/test',
      name: 'coordinator',
      description: 'mock lead',
      role: 'lead',
      tools: [],
      disallowedTools: [],
      skills: [],
      requires: [],
      background: false,
      maxTurns: 10,
      systemPrompt: 'You are the team lead.',
    } as never);

    // resolvePrimaryConversation returns a conversation id — the only
    // path that lets the lead stamp conversationId on its outputs.
    selectChain.limit.mockResolvedValueOnce([{ id: 'conv-stamp' }]);

    // The mailbox drain seeds the lead's request id (== user_prompt
    // messageId, the synthetic runId the API route advertises to SSE).
    vi.mocked(drainMailbox).mockResolvedValueOnce([
      {
        id: 'msg-user-prompt',
        toAgentId: 'lead-stamp',
        type: 'user_prompt',
        messageType: 'message',
        content: 'Founder asked something.',
        createdAt: new Date(),
      },
    ]);

    runAgentHoisted.fn.mockImplementationOnce(async (...args: unknown[]) => {
      const onEvent = args[7] as
        | ((event: {
            type: string;
            messageId?: string;
            turn?: number;
            blockIndex?: number;
            text?: string;
          }) => void | Promise<void>)
        | undefined;
      if (onEvent) {
        await onEvent({
          type: 'assistant_text_stop',
          messageId: 'm-stamp-1',
          turn: 1,
          blockIndex: 0,
          text: 'Lead reply.',
        });
      }
      return {
        result: 'done',
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

    await processAgentRun(makeJob('lead-stamp'));

    // (a) DB row stamps the lead's primary conversationId so the founder
    // UI's per-thread filter renders the reply.
    const insertedRows = insertChain.values.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    const turnRow = insertedRows.find(
      (r) => r.type === 'agent_text' && r.fromAgentId === 'lead-stamp',
    );
    expect(turnRow).toBeDefined();
    expect(turnRow!.conversationId).toBe('conv-stamp');

    // (b) SSE publish carries conversationId AND runId so the typing
    // indicator can pair with the user_prompt and the bubble lands in
    // the right thread.
    const sseAgentText = publishMock.mock.calls
      .map((c) => JSON.parse((c as unknown as [string, string])[1]))
      .find((p) => p.type === 'agent_text');
    expect(sseAgentText).toBeDefined();
    expect(sseAgentText.conversationId).toBe('conv-stamp');
    expect(sseAgentText.runId).toBe('msg-user-prompt');
  });

  it('lead publishes a terminal completion SSE event when the run ends naturally', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'lead-term',
      teamId: 'team-term',
      memberId: 'mem-term',
      agentDefName: 'coordinator',
      parentAgentId: null,
      status: 'queued',
    } as never);

    vi.mocked(resolveAgent).mockResolvedValueOnce({
      source: 'built-in',
      sourcePath: '/test',
      name: 'coordinator',
      description: 'mock lead',
      role: 'lead',
      tools: [],
      disallowedTools: [],
      skills: [],
      requires: [],
      background: false,
      maxTurns: 10,
      systemPrompt: 'You are the team lead.',
    } as never);

    selectChain.limit.mockResolvedValueOnce([{ id: 'conv-term' }]);

    vi.mocked(drainMailbox).mockResolvedValueOnce([
      {
        id: 'msg-user-term',
        toAgentId: 'lead-term',
        type: 'user_prompt',
        messageType: 'message',
        content: 'Founder ask.',
        createdAt: new Date(),
      },
    ]);

    // runAgent returns end_turn naturally (default mock returns
    // 'completed'-shaped result without invoking onEvent).
    await processAgentRun(makeJob('lead-term'));

    // A terminal SSE event of type 'completion' must have fired with
    // the same runId the user_prompt advertised, and the lead's
    // conversationId so the client routes it to the right thread.
    const terminal = publishMock.mock.calls
      .map((c) => JSON.parse((c as unknown as [string, string])[1]))
      .find((p) => p.type === 'completion' || p.type === 'error');
    expect(terminal).toBeDefined();
    expect(terminal.type).toBe('completion');
    expect(terminal.runId).toBe('msg-user-term');
    expect(terminal.conversationId).toBe('conv-term');
    expect(terminal.teamId).toBe('team-term');
  });

  it('teammate (non-lead) does NOT publish a terminal SSE event', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'mate-no-term',
      teamId: 'team-quiet',
      memberId: 'mem-quiet',
      agentDefName: 'content-manager',
      parentAgentId: 'lead-agent',
      status: 'queued',
    } as never);

    // Default resolveAgent mock returns role='member'.
    await processAgentRun(makeJob('mate-no-term'));

    const terminal = publishMock.mock.calls
      .map((c) => JSON.parse((c as unknown as [string, string])[1]))
      .find((p) => p.type === 'completion' || p.type === 'error');
    expect(terminal).toBeUndefined();
  });
});
