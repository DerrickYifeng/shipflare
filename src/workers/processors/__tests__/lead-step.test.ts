// Unit tests for the D2 `leadStep` pure decision function.
//
// Strategy: mock `runAgent` at the boundary so we don't load the Anthropic
// SDK or hit the network. The mock drives the `observer` callback to
// simulate the tool_start / tool_done events runAgent would emit for
// async Task / Sleep, then returns an AgentResult. We assert leadStep
// classifies the outcome correctly.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { LlmRateLimitedError } from '@/core/api-client';
import type {
  AgentConfig,
  AgentResult,
  StreamEvent,
  ToolContext,
} from '@/core/types';
import type { runAgent } from '@/core/query-loop';
import { leadStep } from '../lead-step';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCtx(): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    get<T>(_key: string): T {
      throw new Error('not used in leadStep unit tests');
    },
  };
}

function makeConfig(): AgentConfig {
  return {
    name: 'coordinator',
    systemPrompt: 'You are the lead.',
    model: 'claude-sonnet-4-6',
    tools: [],
    maxTurns: 10,
  };
}

function emptyUsage(): AgentResult<unknown>['usage'] {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    model: 'claude-sonnet-4-6',
    turns: 1,
  };
}

// Build a runAgent stub that fires a scripted sequence of stream events
// at the `observer` arg (positional index 7 in the runAgent signature)
// and then resolves with the supplied result. Mirrors the
// `onEvent: (event: StreamEvent) => void | Promise<void>` callback shape.
function mockRunAgentWith(
  events: StreamEvent[],
  result: AgentResult<unknown>,
): typeof runAgent {
  return (async (
    _config: AgentConfig,
    _userMessage: string,
    _ctx: ToolContext,
    _outputSchema: unknown,
    _onProgress: unknown,
    _prebuilt: unknown,
    _onIdleReset: unknown,
    onEvent?: (event: StreamEvent) => void | Promise<void>,
    _injectMessages?: () => Anthropic.Messages.MessageParam[],
    _priorMessages?: Anthropic.Messages.MessageParam[],
  ): Promise<AgentResult<unknown>> => {
    if (onEvent) {
      for (const ev of events) {
        await Promise.resolve(onEvent(ev));
      }
    }
    return result;
  }) as unknown as typeof runAgent;
}

function asyncLaunchedEvents(
  toolUseId: string,
  agentType: string,
  prompt: string,
): StreamEvent[] {
  return [
    {
      type: 'tool_start',
      toolName: 'Task',
      toolUseId,
      input: {
        subagent_type: agentType,
        prompt,
        description: 'spawn',
        run_in_background: true,
      },
    },
    {
      type: 'tool_done',
      toolName: 'Task',
      toolUseId,
      result: {
        tool_use_id: toolUseId,
        content: JSON.stringify({
          result: null,
          cost: 0,
          duration: 0,
          turns: 0,
          agentId: 'spawned-' + toolUseId,
          status: 'async_launched',
        }),
      },
      durationMs: 5,
    },
  ];
}

function sleepEvents(durationMs: number): StreamEvent[] {
  return [
    {
      type: 'tool_start',
      toolName: 'Sleep',
      toolUseId: 'sleep-1',
      input: { duration_ms: durationMs },
    },
    {
      type: 'tool_done',
      toolName: 'Sleep',
      toolUseId: 'sleep-1',
      result: {
        tool_use_id: 'sleep-1',
        content: JSON.stringify({
          slept: true,
          agentId: 'a-1',
          durationMs,
          wakeAt: new Date(Date.now() + durationMs).toISOString(),
        }),
      },
      durationMs: 2,
    },
  ];
}

// Helper: seed mailbox with a single non-empty message, so tests that
// exercise sleep/spawn/done paths don't accidentally trigger the
// spurious-wake guard when they pass non-empty `history`.
function mailboxWith(content: string): Parameters<typeof leadStep>[0]['mailbox'] {
  return [
    {
      id: 'm-1',
      toAgentId: 'a-1',
      type: 'user_prompt',
      messageType: 'message',
      content,
      createdAt: new Date(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('leadStep — decision classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns spurious_wake when history is non-empty and mailbox is empty (no new mail)', async () => {
    // Regression test for the 2026-05-12 cache_control-on-empty-text bug
    // (agent-run.ts:820-895). leadStep MUST short-circuit before
    // invoking runAgent — otherwise the empty seed user message lands
    // in Anthropic's conversation array, gets a cache_control:ephemeral
    // breakpoint, and the API rejects with 400.
    const runAgentMock = vi.fn();
    const result = await leadStep(
      {
        agentId: 'a-1',
        history: [{ role: 'user', content: 'old msg' }],
        mailbox: [],
        checkpoint: null,
        tenantId: 'u-1',
      },
      {
        config: makeConfig(),
        ctx: makeCtx(),
        runAgentImpl: runAgentMock as unknown as typeof runAgent,
      },
    );

    expect(result.kind).toBe('spurious_wake');
    // Critical: no LLM call was burned.
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('does NOT return spurious_wake on a fresh spawn (empty history + empty mailbox is a different bug path)', async () => {
    // Empty mailbox + empty history is a "spawned with no content"
    // condition that today fails loud via agent-run.ts:880-894. leadStep
    // itself does not handle that — D3 will continue to handle it at
    // the caller layer. Asserting here that the guard is correctly
    // gated on `history.length > 0` so the guard doesn't swallow that
    // bug path.
    const runAgentImpl = mockRunAgentWith([], {
      result: 'ok',
      usage: emptyUsage(),
    });
    const result = await leadStep(
      {
        agentId: 'a-1',
        history: [],
        mailbox: [],
        checkpoint: null,
        tenantId: 'u-1',
      },
      {
        config: makeConfig(),
        ctx: makeCtx(),
        runAgentImpl,
      },
    );
    // Falls through to done (runAgent runs against empty seed); the
    // empty-history branch does NOT mask the "fresh spawn with no
    // content" condition.
    expect(result.kind).toBe('done');
  });

  it('returns spawn_and_wait when runAgent emits async Task tool_use', async () => {
    const events = asyncLaunchedEvents('tu-1', 'researcher', 'find sources');
    const runAgentImpl = mockRunAgentWith(events, {
      result: 'lead summary after spawn',
      usage: emptyUsage(),
    });

    const result = await leadStep(
      {
        agentId: 'a-1',
        history: [],
        mailbox: [],
        checkpoint: null,
        tenantId: 'u-1',
      },
      {
        config: makeConfig(),
        ctx: makeCtx(),
        runAgentImpl,
      },
    );

    expect(result.kind).toBe('spawn_and_wait');
    if (result.kind === 'spawn_and_wait') {
      expect(result.spawns.length).toBe(1);
      expect(result.spawns[0]).toMatchObject({
        toolUseId: 'tu-1',
        agentType: 'researcher',
        prompt: 'find sources',
      });
      expect(result.newCheckpoint.pendingToolUseIds).toEqual(['tu-1']);
      expect(result.newCheckpoint.lastProcessedIndex).toBe(0);
      expect(result.newCheckpoint.state).toEqual({});
    }
  });

  it('collects multiple async Task spawns into one spawn_and_wait decision', async () => {
    const events: StreamEvent[] = [
      ...asyncLaunchedEvents('tu-1', 'researcher', 'task 1'),
      ...asyncLaunchedEvents('tu-2', 'writer', 'task 2'),
    ];
    const runAgentImpl = mockRunAgentWith(events, {
      result: 'spawned two',
      usage: emptyUsage(),
    });

    const result = await leadStep(
      {
        agentId: 'a-1',
        // history is non-empty, mailbox is non-empty — bypasses the
        // spurious-wake guard so we actually exercise classification.
        history: [{ role: 'user', content: 'hello' }],
        mailbox: mailboxWith('please do these'),
        checkpoint: {
          lastProcessedIndex: 0,
          pendingToolUseIds: ['prior-tu'],
          state: { foo: 'bar' },
        },
        tenantId: 'u-1',
      },
      {
        config: makeConfig(),
        ctx: makeCtx(),
        runAgentImpl,
      },
    );

    expect(result.kind).toBe('spawn_and_wait');
    if (result.kind === 'spawn_and_wait') {
      expect(result.spawns.map((s) => s.toolUseId)).toEqual(['tu-1', 'tu-2']);
      // Existing pendingToolUseIds from prior checkpoint must be preserved.
      expect(result.newCheckpoint.pendingToolUseIds).toEqual([
        'prior-tu',
        'tu-1',
        'tu-2',
      ]);
      // Existing state must be carried forward.
      expect(result.newCheckpoint.state).toEqual({ foo: 'bar' });
      expect(result.newCheckpoint.lastProcessedIndex).toBe(1);
    }
  });

  it('returns sleep when runAgent emits Sleep tool_use', async () => {
    const events = sleepEvents(30_000);
    const runAgentImpl = mockRunAgentWith(events, {
      result: 'pre-sleep text',
      usage: emptyUsage(),
    });
    const before = Date.now();

    const result = await leadStep(
      {
        agentId: 'a-1',
        history: [{ role: 'user', content: 'wait for me' }],
        // Non-empty mailbox so the spurious-wake guard does not short-
        // circuit before runAgent is invoked.
        mailbox: mailboxWith('please wait'),
        checkpoint: null,
        tenantId: 'u-1',
      },
      {
        config: makeConfig(),
        ctx: makeCtx(),
        runAgentImpl,
      },
    );

    expect(result.kind).toBe('sleep');
    if (result.kind === 'sleep') {
      expect(result.untilMs).toBeGreaterThanOrEqual(before + 30_000);
      // Allow up to 1s of test-runner jitter on the upper bound.
      expect(result.untilMs).toBeLessThan(Date.now() + 30_000 + 1000);
      expect(result.newCheckpoint.lastProcessedIndex).toBe(1);
      expect(result.newCheckpoint.pendingToolUseIds).toEqual([]);
    }
  });

  it('returns done when runAgent terminates with a final assistant message', async () => {
    const runAgentImpl = mockRunAgentWith([], {
      result: 'final answer',
      usage: emptyUsage(),
    });

    const result = await leadStep(
      {
        agentId: 'a-1',
        history: [],
        mailbox: mailboxWith('hello'),
        checkpoint: null,
        tenantId: 'u-1',
      },
      {
        config: makeConfig(),
        ctx: makeCtx(),
        runAgentImpl,
      },
    );

    expect(result.kind).toBe('done');
    if (result.kind === 'done') {
      expect(result.summary).toBe('final answer');
    }
  });

  it('sleep wins over spawn when both fired in the same step', async () => {
    // Realistic scenario: agent issues a spawn THEN a sleep in the same
    // multi-turn loop. Sleep already aborted runAgent, so D3 should yield
    // for the sleep, NOT route into the spawn_and_wait branch.
    const events: StreamEvent[] = [
      ...asyncLaunchedEvents('tu-1', 'researcher', 'task 1'),
      ...sleepEvents(10_000),
    ];
    const runAgentImpl = mockRunAgentWith(events, {
      result: 'mid-flight text',
      usage: emptyUsage(),
    });

    const result = await leadStep(
      {
        agentId: 'a-1',
        history: [],
        mailbox: [],
        checkpoint: null,
        tenantId: 'u-1',
      },
      {
        config: makeConfig(),
        ctx: makeCtx(),
        runAgentImpl,
      },
    );

    expect(result.kind).toBe('sleep');
  });

  it('propagates LlmRateLimitedError without classifying as done', async () => {
    const err = new LlmRateLimitedError('tenant', 1500);
    const runAgentImpl: typeof runAgent = (async () => {
      throw err;
    }) as unknown as typeof runAgent;

    await expect(
      leadStep(
        {
          agentId: 'a-1',
          history: [],
          mailbox: [],
          checkpoint: null,
          tenantId: 'u-1',
        },
        {
          config: makeConfig(),
          ctx: makeCtx(),
          runAgentImpl,
        },
      ),
    ).rejects.toBeInstanceOf(LlmRateLimitedError);
  });

  it('forwards every stream event to the parent observer', async () => {
    const events = asyncLaunchedEvents('tu-1', 'researcher', 'go');
    const runAgentImpl = mockRunAgentWith(events, {
      result: 'done',
      usage: emptyUsage(),
    });
    const parentOnEvent = vi.fn();

    await leadStep(
      {
        agentId: 'a-1',
        history: [],
        mailbox: [],
        checkpoint: null,
        tenantId: 'u-1',
      },
      {
        config: makeConfig(),
        ctx: makeCtx(),
        runAgentImpl,
        parentOnEvent,
      },
    );

    expect(parentOnEvent).toHaveBeenCalledTimes(events.length);
    expect(parentOnEvent.mock.calls[0][0].type).toBe('tool_start');
    expect(parentOnEvent.mock.calls[1][0].type).toBe('tool_done');
  });

  it('seeds runAgent with mailbox[0].content only — additional messages are NOT folded in', async () => {
    // Contract: leadStep consumes ONLY mailbox[0]. Additional messages
    // are left to the caller's `pendingInjections` drain to inject at
    // the next idle-turn boundary inside runAgent. Concatenating them
    // here would cause double-injection (the existing agent-run.ts
    // drain timer pushes mailbox 1..N into pendingInjections too).
    let seenSeedPrompt: string | null = null;
    const runAgentImpl: typeof runAgent = (async (
      _config: AgentConfig,
      seedPrompt: string,
    ) => {
      seenSeedPrompt = seedPrompt;
      return { result: 'ok', usage: emptyUsage() };
    }) as unknown as typeof runAgent;

    await leadStep(
      {
        agentId: 'a-1',
        history: [],
        mailbox: [
          {
            id: 'm-1',
            toAgentId: 'a-1',
            type: 'user_prompt',
            messageType: 'message',
            content: 'first segment',
            createdAt: new Date(),
          },
          {
            id: 'm-2',
            toAgentId: 'a-1',
            type: 'user_prompt',
            messageType: 'message',
            content: 'second segment',
            createdAt: new Date(),
          },
        ],
        checkpoint: null,
        tenantId: 'u-1',
      },
      {
        config: makeConfig(),
        ctx: makeCtx(),
        runAgentImpl,
      },
    );

    // First-only: caller's existing pendingInjections drain handles the rest.
    expect(seenSeedPrompt).toBe('first segment');
  });
});
