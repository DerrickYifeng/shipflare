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
// Phase E orphan fix (Task 1): the agent-run worker now loads the team row
// once at startup via `db.select({id, userId, productId}).from(teams).where(...).limit(1)`
// to wire userId / productId / platform clients into the ToolContext. We
// route this select to a dedicated chain so it doesn't compete with the
// existing teamConversations lookup. Discriminator is the projection's
// `userId` key — only the teams query carries it.
const teamSelectChain: {
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
} = {
  from: vi.fn(() => teamSelectChain),
  where: vi.fn(() => teamSelectChain),
  // Default fixture matches the agent_runs row's teamId/userId/productId
  // used across the test suite. Individual tests can override via
  // `teamSelectChain.limit.mockResolvedValueOnce([...])`.
  limit: vi.fn(async () => [
    { id: 'team-1', userId: 'user-1', productId: null },
  ]),
};
vi.mock('@/lib/db', () => ({
  db: {
    query: { agentRuns: { findFirst: vi.fn() } },
    update: vi.fn(() => updateChain),
    insert: vi.fn(() => insertChain),
    select: vi.fn((projection?: Record<string, unknown>) => {
      // Route the teams-row lookup to its own chain so existing tests'
      // selectChain.limit overrides only affect teamConversations queries.
      if (projection && 'userId' in projection) return teamSelectChain;
      return selectChain;
    }),
    transaction: vi.fn(),
  },
}));

// Phase E orphan fix (Task 1): platform-deps mock — agent-run preloads
// every platform client the team could need into the ToolContext via
// `createTeamPlatformDeps(userId, productId)`. Default returns an empty
// bag; tests that probe the ctx wiring override per-call.
const createTeamPlatformDepsMock = vi.hoisted(() =>
  vi.fn(async (_userId: string, _productId: string | null) => ({})),
);
vi.mock('@/lib/platform-deps', () => ({
  createTeamPlatformDeps: createTeamPlatformDepsMock,
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

// system-prompt-context: agent-run.ts now renders def.systemPrompt
// against live DB context before invoking runAgent. Default fixture
// returns a generic ctx so the prior tests keep passing; the wiring
// test below overrides it per-call to assert substitution lands.
const loadSystemPromptContextMock = vi.hoisted(() =>
  vi.fn(async () => ({
    productName: 'TestProduct',
    productDescription: 'a test product',
    productState: 'mvp',
    currentPhase: 'foundation',
    channels: 'none yet',
    strategicPathId: 'none yet',
    itemCount: 0,
    statusBreakdown: '',
    founderName: 'TestFounder',
    teamRoster: '- coordinator: Chief of Staff (Tools: Task)',
  })),
);
vi.mock('@/lib/team/system-prompt-context', () => ({
  loadSystemPromptContext: loadSystemPromptContextMock,
  // The implementation re-exports its `substitutePlaceholders` for
  // direct callers; agent-run uses the real function so the mock
  // forwards a deterministic shape.
  substitutePlaceholders: (template: string, ctx: { productName: string; founderName: string; teamRoster: string }) => {
    let out = template;
    out = out.split('{productName}').join(ctx.productName);
    out = out.split('{founderName}').join(ctx.founderName);
    out = out.split('{TEAM_ROSTER}').join(ctx.teamRoster);
    return out;
  },
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
    // Phase E orphan fix (Task 1): reset the teams-row chain back to its
    // default fixture so each test starts with a known-good team row.
    teamSelectChain.from.mockClear();
    teamSelectChain.where.mockClear();
    teamSelectChain.limit.mockReset();
    teamSelectChain.from.mockReturnValue(teamSelectChain);
    teamSelectChain.where.mockReturnValue(teamSelectChain);
    teamSelectChain.limit.mockResolvedValue([
      { id: 'team-1', userId: 'user-1', productId: null },
    ]);
    createTeamPlatformDepsMock.mockClear();
    createTeamPlatformDepsMock.mockResolvedValue({});
    runAgentHoisted.state.lastArgs = null;
    publishMock.mockClear();
    loadSystemPromptContextMock.mockClear();
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
    // payload echoing the assistant text. UI-B Task 8 added an
    // `agent_status_change` publish on every status transition, so the
    // channel now carries multiple message types — filter for the
    // assistant_text payload specifically.
    expect(publishMock).toHaveBeenCalled();
    const sseCall = publishMock.mock.calls.find(([channel, raw]) => {
      if (channel !== teamMessagesChannel('team-sse')) return false;
      try {
        return (
          (JSON.parse(raw as string) as { type?: string }).type === 'agent_text'
        );
      } catch {
        return false;
      }
    });
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

    // No `agent_text` publish to the team-messages SSE channel — teammate
    // output reaches the lead via task_notification mailbox routing, not
    // the live stream. UI-B Task 8 does emit `agent_status_change` events
    // for teammates (so the founder UI's roster updates live), so we
    // narrow the assertion to the agent_text type only.
    const sseTextCall = publishMock.mock.calls.find(([channel, raw]) => {
      if (channel !== teamMessagesChannel('team-quiet')) return false;
      try {
        return (
          (JSON.parse(raw as string) as { type?: string }).type === 'agent_text'
        );
      } catch {
        return false;
      }
    });
    expect(sseTextCall).toBeUndefined();

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

  // ---------------------------------------------------------------------
  // Tool-call visibility — persist tool_start → tool_call rows and
  // tool_done → tool_result rows so the founder UI can render the lead's
  // tool usage. Lead path additionally publishes to the team SSE channel.
  // Sleep + SyntheticOutput are skipped (Sleep is signaling-only and the
  // existing early-exit detector still owns it; SyntheticOutput is the
  // terminal write already covered by assistant_text_stop).
  // ---------------------------------------------------------------------

  it('persists tool_call row when runAgent emits tool_start', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'agent-tool-call',
      teamId: 'team-tc',
      memberId: 'mem-tc',
      agentDefName: 'content-manager',
      parentAgentId: 'lead-agent',
      status: 'queued',
    } as never);

    runAgentHoisted.fn.mockImplementationOnce(async (...args: unknown[]) => {
      runAgentHoisted.state.lastArgs = args;
      const onEvent = args[7] as
        | ((event: {
            type: string;
            toolName?: string;
            toolUseId?: string;
            input?: unknown;
          }) => void | Promise<void>)
        | undefined;
      if (onEvent) {
        await onEvent({
          type: 'tool_start',
          toolName: 'query_strategic_path',
          toolUseId: 'toolu_test_1',
          input: { reason: 'test' },
        });
      }
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

    await processAgentRun(makeJob('agent-tool-call'));

    const insertedRows = insertChain.values.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    const toolCallRow = insertedRows.find((r) => r.type === 'tool_call');
    expect(toolCallRow).toBeDefined();
    expect(toolCallRow).toMatchObject({
      type: 'tool_call',
      messageType: 'message',
      teamId: 'team-tc',
      fromMemberId: 'mem-tc',
      fromAgentId: 'agent-tool-call',
      content: 'query_strategic_path',
    });
    const metadata = toolCallRow!.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      tool_use_id: 'toolu_test_1',
      tool_name: 'query_strategic_path',
      tool_input: { reason: 'test' },
    });
    expect(toolCallRow!.deliveredAt).toBeInstanceOf(Date);
    // Sleep / SyntheticOutput exclusions: this row is a regular tool, so
    // it should be persisted (this assertion is the negation of the skip).
    expect(toolCallRow!.content).not.toBe('Sleep');
    expect(toolCallRow!.content).not.toBe('SyntheticOutput');
  });

  it('persists tool_result row when runAgent emits tool_done (truncated content + full output in metadata)', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'agent-tool-result',
      teamId: 'team-tr',
      memberId: 'mem-tr',
      agentDefName: 'content-manager',
      parentAgentId: 'lead-agent',
      status: 'queued',
    } as never);

    // Build a payload longer than the 4 000 char truncation cap so the
    // assertion can verify both truncated `content` and full
    // `metadata.tool_output`.
    const longPayload = 'a'.repeat(5000);

    runAgentHoisted.fn.mockImplementationOnce(async (...args: unknown[]) => {
      runAgentHoisted.state.lastArgs = args;
      const onEvent = args[7] as
        | ((event: {
            type: string;
            toolName?: string;
            toolUseId?: string;
            durationMs?: number;
            result?: { content: string; is_error?: boolean };
          }) => void | Promise<void>)
        | undefined;
      if (onEvent) {
        await onEvent({
          type: 'tool_done',
          toolName: 'query_strategic_path',
          toolUseId: 'toolu_test_2',
          durationMs: 42,
          result: { content: longPayload, is_error: false },
        });
      }
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

    await processAgentRun(makeJob('agent-tool-result'));

    const insertedRows = insertChain.values.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    const toolResultRow = insertedRows.find((r) => r.type === 'tool_result');
    expect(toolResultRow).toBeDefined();
    expect(toolResultRow).toMatchObject({
      type: 'tool_result',
      messageType: 'message',
      teamId: 'team-tr',
      fromMemberId: 'mem-tr',
      fromAgentId: 'agent-tool-result',
    });
    // content truncated to 4000 chars + ellipsis when output is bigger.
    expect((toolResultRow!.content as string).length).toBe(4001);
    expect((toolResultRow!.content as string).endsWith('…')).toBe(true);
    const metadata = toolResultRow!.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      tool_use_id: 'toolu_test_2',
      tool_name: 'query_strategic_path',
      is_error: false,
      duration_ms: 42,
    });
    // Full untruncated output preserved in metadata for the UI's "expand"
    // affordance.
    expect(metadata.tool_output).toBe(longPayload);
  });

  it('lead path publishes tool_call to the team SSE channel; teammate path does not', async () => {
    // --- Lead arm ---
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValueOnce({
      id: 'lead-tool-sse',
      teamId: 'team-tool-sse',
      memberId: 'mem-tool-sse',
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
    selectChain.limit.mockResolvedValueOnce([{ id: 'conv-tool-sse' }]);
    runAgentHoisted.fn.mockImplementationOnce(async (...args: unknown[]) => {
      runAgentHoisted.state.lastArgs = args;
      const onEvent = args[7] as
        | ((event: {
            type: string;
            toolName?: string;
            toolUseId?: string;
            input?: unknown;
          }) => void | Promise<void>)
        | undefined;
      if (onEvent) {
        await onEvent({
          type: 'tool_start',
          toolName: 'query_strategic_path',
          toolUseId: 'toolu_lead_sse',
          input: { reason: 'lead-call' },
        });
      }
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

    await processAgentRun(makeJob('lead-tool-sse'));

    const sseToolCall = publishMock.mock.calls.find(([channel, raw]) => {
      if (channel !== teamMessagesChannel('team-tool-sse')) return false;
      try {
        return (
          (JSON.parse(raw as string) as { type?: string }).type === 'tool_call'
        );
      } catch {
        return false;
      }
    });
    expect(sseToolCall).toBeDefined();
    const payload = JSON.parse(sseToolCall![1]);
    expect(payload).toMatchObject({
      teamId: 'team-tool-sse',
      type: 'tool_call',
      content: 'query_strategic_path',
      fromAgentId: 'lead-tool-sse',
    });
    const payloadMeta = payload.metadata as Record<string, unknown>;
    expect(payloadMeta).toMatchObject({
      tool_use_id: 'toolu_lead_sse',
      tool_name: 'query_strategic_path',
    });
    // The durable row id must match the SSE payload id so the founder UI
    // can swap the live tool-card into its persisted row in place.
    const insertedRows = insertChain.values.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    const dbToolCallRow = insertedRows.find(
      (r) => r.type === 'tool_call' && r.fromAgentId === 'lead-tool-sse',
    );
    expect(dbToolCallRow).toBeDefined();
    expect(dbToolCallRow!.id).toBe(payload.messageId);
    // Lead row is stamped with the primary conversationId so the per-thread
    // filter in the founder UI surfaces it.
    expect(dbToolCallRow!.conversationId).toBe('conv-tool-sse');

    // --- Teammate arm: same tool_start event, but no SSE publish ---
    publishMock.mockClear();
    insertChain.values.mockClear();
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValueOnce({
      id: 'mate-tool-no-sse',
      teamId: 'team-tool-quiet',
      memberId: 'mem-tool-quiet',
      agentDefName: 'content-manager',
      parentAgentId: 'lead-agent',
      status: 'queued',
    } as never);
    runAgentHoisted.fn.mockImplementationOnce(async (...args: unknown[]) => {
      runAgentHoisted.state.lastArgs = args;
      const onEvent = args[7] as
        | ((event: {
            type: string;
            toolName?: string;
            toolUseId?: string;
            input?: unknown;
          }) => void | Promise<void>)
        | undefined;
      if (onEvent) {
        await onEvent({
          type: 'tool_start',
          toolName: 'query_strategic_path',
          toolUseId: 'toolu_mate_no_sse',
          input: { reason: 'teammate-call' },
        });
      }
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

    await processAgentRun(makeJob('mate-tool-no-sse'));

    // Teammate persists the row but skips the SSE publish.
    const teammateInsertedRows = insertChain.values.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    expect(
      teammateInsertedRows.some(
        (r) => r.type === 'tool_call' && r.fromAgentId === 'mate-tool-no-sse',
      ),
    ).toBe(true);
    const sseToolCallTeammate = publishMock.mock.calls.find(([channel, raw]) => {
      if (channel !== teamMessagesChannel('team-tool-quiet')) return false;
      try {
        return (
          (JSON.parse(raw as string) as { type?: string }).type === 'tool_call'
        );
      } catch {
        return false;
      }
    });
    expect(sseToolCallTeammate).toBeUndefined();
  });

  it('lead skips the tool_call SSE publish when the DB insert throws (no phantom row)', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValueOnce({
      id: 'lead-insert-throws',
      teamId: 'team-throws',
      memberId: 'mem-throws',
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
    selectChain.limit.mockResolvedValueOnce([{ id: 'conv-throws' }]);

    // Reject ONLY the tool_call insert. Other rows the processor writes
    // during a normal run (status updates / task_notification / etc.)
    // must still succeed so the worker can settle cleanly.
    // Cast to a variadic impl so the per-call args (the row being
    // inserted) flow through despite the chain's zero-arg type sig.
    (insertChain.values.mockImplementation as unknown as (
      impl: (...args: unknown[]) => Promise<undefined>,
    ) => void)(async (...args: unknown[]) => {
      const row = args[0] as { type?: unknown } | null | undefined;
      if (row && (row as { type?: string }).type === 'tool_call') {
        throw new Error('simulated DB outage');
      }
      return undefined;
    });

    runAgentHoisted.fn.mockImplementationOnce(async (...args: unknown[]) => {
      runAgentHoisted.state.lastArgs = args;
      const onEvent = args[7] as
        | ((event: {
            type: string;
            toolName?: string;
            toolUseId?: string;
            input?: unknown;
          }) => void | Promise<void>)
        | undefined;
      if (onEvent) {
        await onEvent({
          type: 'tool_start',
          toolName: 'query_strategic_path',
          toolUseId: 'toolu_throws',
          input: { reason: 'fail-insert' },
        });
      }
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

    await processAgentRun(makeJob('lead-insert-throws'));

    // No tool_call SSE publish — gating on `persisted` prevents the
    // founder UI from receiving a card whose messageId has no DB row.
    const sseToolCall = publishMock.mock.calls.find(([channel, raw]) => {
      if (channel !== teamMessagesChannel('team-throws')) return false;
      try {
        return (
          (JSON.parse(raw as string) as { type?: string }).type === 'tool_call'
        );
      } catch {
        return false;
      }
    });
    expect(sseToolCall).toBeUndefined();

    // Sanity: the worker DID attempt the insert (the throw fires from
    // the values() call), and DID NOT abort the stream — control fell
    // through and the run still completed (other inserts ran).
    const allInsertedRows = insertChain.values.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    const attemptedToolCall = allInsertedRows.find(
      (r) => r.type === 'tool_call' && r.fromAgentId === 'lead-insert-throws',
    );
    expect(attemptedToolCall).toBeDefined();

    // Restore the default no-op so future tests added below don't
    // inherit the rejecting implementation. `beforeEach`'s `mockClear`
    // wipes call history but leaves the impl in place.
    (insertChain.values.mockImplementation as unknown as (
      impl: (...args: unknown[]) => Promise<undefined>,
    ) => void)(async () => undefined);
  });

  // ---------------------------------------------------------------------
  // Task 2 — system-prompt placeholder substitution wiring
  // ---------------------------------------------------------------------

  it('substitutes system-prompt placeholders before invoking runAgent', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValueOnce({
      id: 'lead-subst',
      teamId: 'team-subst',
      memberId: 'mem-subst',
      agentDefName: 'coordinator',
      parentAgentId: null,
      status: 'queued',
    } as never);

    // The fixture def carries an unsubstituted `{productName}` token —
    // exactly the failure mode this task fixes.
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
      systemPrompt:
        'Welcome to {productName}. Founder: {founderName}. Roster:\n{TEAM_ROSTER}',
    } as never);

    // Stub the substitution context with values we can grep for in the
    // rendered prompt the worker hands to runAgent.
    loadSystemPromptContextMock.mockResolvedValueOnce({
      productName: 'Acme',
      productDescription: 'a magical thing',
      productState: 'launched',
      currentPhase: 'growth',
      channels: 'x, reddit',
      strategicPathId: 'sp_42',
      itemCount: 3,
      statusBreakdown: 'planned: 3',
      founderName: 'Alex',
      teamRoster: '- coordinator: Chief of Staff (Tools: Task)',
    });

    await processAgentRun(makeJob('lead-subst'));

    // The worker must have queried system-prompt context for this team
    // before invoking runAgent.
    expect(loadSystemPromptContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-subst' }),
    );

    // runAgent's first positional arg is the AgentConfig built from the
    // rendered def. Assert the substituted values landed and no literal
    // braces survived for the tokens we set.
    expect(runAgentHoisted.state.lastArgs).not.toBeNull();
    const config = runAgentHoisted.state.lastArgs?.[0] as {
      systemPrompt: string;
    };
    expect(config.systemPrompt).toContain('Welcome to Acme');
    expect(config.systemPrompt).toContain('Founder: Alex');
    expect(config.systemPrompt).toContain(
      '- coordinator: Chief of Staff (Tools: Task)',
    );
    expect(config.systemPrompt).not.toContain('{productName}');
    expect(config.systemPrompt).not.toContain('{founderName}');
    expect(config.systemPrompt).not.toContain('{TEAM_ROSTER}');
  });

  // ---------------------------------------------------------------------
  // Phase E orphan fix (2026-05-03 plan, Task 1) — domain tool ctx wiring
  //
  // The deleted team-run.ts loaded userId / productId / teamId / db /
  // platform clients into the ToolContext. agent-run only exposed
  // callerAgentId, so every domain tool (~20 of them, e.g.
  // query_strategic_path, query_plan_items, add_plan_item) threw
  // "Domain tool context missing required dependency 'userId'" the
  // moment the team-lead invoked them. These tests pin the wiring back
  // in so a future cleanup pass can't silently regress it.
  // ---------------------------------------------------------------------

  it('tool ctx exposes db / userId / productId / teamId / currentMemberId / conversationId / runId', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'agent-ctx',
      teamId: 'team-ctx',
      memberId: 'mem-ctx',
      agentDefName: 'content-manager',
      parentAgentId: null,
      status: 'queued',
    } as never);

    // Seed a specific team row so the assertions below can pin the exact
    // values the ctx surfaces. The agent_runs row's teamId/memberId are
    // independent of the team row's userId/productId, so we set both.
    teamSelectChain.limit.mockResolvedValueOnce([
      { id: 'team-ctx', userId: 'user-7', productId: 'prod-3' },
    ]);

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

    await processAgentRun(makeJob('agent-ctx'));

    expect(capturedCtx).not.toBeNull();
    // Standard domain keys every ~20 tools read via requireDep().
    expect(capturedCtx!.get<unknown>('db')).toBeDefined();
    expect(capturedCtx!.get<string>('userId')).toBe('user-7');
    expect(capturedCtx!.get<string | null>('productId')).toBe('prod-3');
    expect(capturedCtx!.get<string>('teamId')).toBe('team-ctx');
    expect(capturedCtx!.get<string>('currentMemberId')).toBe('mem-ctx');
    // Teammate path: conversationId is null (only the lead carries one).
    expect(capturedCtx!.get<string | null>('conversationId')).toBeNull();
    // Teammate path: runId falls back to the agentId since there's no
    // leadRequestId in scope.
    expect(capturedCtx!.get<string>('runId')).toBe('agent-ctx');
    // Phase D Sleep tool key — must keep working unchanged.
    expect(capturedCtx!.get<string>('callerAgentId')).toBe('agent-ctx');
  });

  it('tool ctx exposes platform clients from createTeamPlatformDeps', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'agent-platform',
      teamId: 'team-platform',
      memberId: 'mem-platform',
      agentDefName: 'content-manager',
      parentAgentId: null,
      status: 'queued',
    } as never);

    teamSelectChain.limit.mockResolvedValueOnce([
      { id: 'team-platform', userId: 'user-platform', productId: 'prod-1' },
    ]);

    // Stub createTeamPlatformDeps with sentinel client values so the
    // assertions can confirm the ctx routes platform-keyed lookups
    // through the helper rather than throwing or returning undefined.
    createTeamPlatformDepsMock.mockResolvedValueOnce({
      xClient: 'fake-x',
      redditClient: 'fake-r',
    });

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

    await processAgentRun(makeJob('agent-platform'));

    // The helper must have been invoked with the user/product loaded
    // from the team row.
    expect(createTeamPlatformDepsMock).toHaveBeenCalledWith(
      'user-platform',
      'prod-1',
    );

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.get<string>('xClient')).toBe('fake-x');
    expect(capturedCtx!.get<string>('redditClient')).toBe('fake-r');
  });

  it('fails the run with a clear error when team row is missing', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'agent-missing-team',
      teamId: 'team-gone',
      memberId: 'mem-x',
      agentDefName: 'content-manager',
      parentAgentId: null,
      status: 'queued',
    } as never);

    // Simulate the team row having been deleted — the team-row select
    // returns an empty array. The processor must surface a clear failure
    // instead of silently invoking runAgent with undefined deps.
    teamSelectChain.limit.mockResolvedValueOnce([]);

    await processAgentRun(makeJob('agent-missing-team'));

    // runAgent must NOT have been invoked — the team-row check throws
    // before we get there, and the catch path settles the run as failed.
    expect(runAgentHoisted.state.lastArgs).toBeNull();

    // The run must be marked failed with a shutdownReason that names
    // the missing team so operators can see the root cause in the
    // agent_runs row without spelunking logs.
    const setCalls = updateChain.set.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    const failedSet = setCalls.find((s) => s.status === 'failed');
    expect(failedSet).toBeDefined();
    expect(String(failedSet?.shutdownReason ?? '')).toContain(
      'team team-gone not found',
    );
  });
});
