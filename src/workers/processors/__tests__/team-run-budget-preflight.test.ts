/**
 * Unit test for the team-run pre-flight budget check.
 *
 * Verifies that when `teamHasBudgetRemaining` returns false, the
 * processor aborts BEFORE any LLM work happens — no coordinator
 * `runAgent` invocation, no user_prompt message, just a `failed` row
 * with a `BUDGET_EXCEEDED` error.
 *
 * We mock @/lib/team-budget + @/core/query-loop at the module boundary
 * rather than replaying the integration fixture's full db/redis fakes;
 * the goal here is coverage of the gate, not the whole pipeline.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';

const hoisted = vi.hoisted(() => ({
  teamHasBudgetRemainingMock: vi.fn<(teamId: string, db: unknown) => Promise<boolean>>(),
  getTeamBudgetSnapshotMock: vi.fn(),
  maybeEmitBudgetWarningMock: vi.fn(async () => undefined),
  runAgentMock: vi.fn(),
  teamRow: {
    id: 'team-1',
    userId: 'user-1',
    productId: null as string | null,
  },
  runRow: {
    id: 'run-1',
    teamId: 'team-1',
    // Chat refactor: runs are now always attached to a conversation;
    // the processor bails early with a non-retryable failure if this
    // is null. Tests that want to exercise the pre-flight budget path
    // provide a synthetic id here.
    conversationId: 'conv-1' as string | null,
    // Must start in 'pending' so the processor's idempotent gate lets
    // it flip to 'running' and reach the pre-flight check.
    status: 'pending',
    goal: 'test goal',
    rootAgentId: 'mem-1',
    traceId: 'trace-1',
  },
  updateCalls: [] as Array<Record<string, unknown>>,
}));

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

vi.mock('@/lib/team-budget', () => ({
  teamHasBudgetRemaining: hoisted.teamHasBudgetRemainingMock,
  getTeamBudgetSnapshot: hoisted.getTeamBudgetSnapshotMock,
  maybeEmitBudgetWarning: hoisted.maybeEmitBudgetWarningMock,
}));

vi.mock('@/core/query-loop', () => ({
  runAgent: hoisted.runAgentMock,
  createToolContext: (deps: Record<string, unknown>) => ({
    abortSignal: new AbortController().signal,
    get: (k: string) => deps[k],
  }),
}));

// Surface the subset of drizzle-orm helpers team-run.ts imports. The
// pre-flight path never reaches the compound WHERE clauses, so we only
// need identity stubs that don't throw on construction.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
  return {
    ...actual,
    eq: () => ({}),
    and: () => ({}),
    not: () => ({}),
    inArray: () => ({}),
    desc: () => ({}),
  };
});

// Schema identity stubs — the processor only reads column symbols.
vi.mock('@/lib/db/schema', () => ({
  teams: { id: 'id', userId: 'userId', productId: 'productId', config: 'config' },
  teamMembers: {
    id: 'id',
    teamId: 'teamId',
    agentType: 'agentType',
    displayName: 'displayName',
  },
  teamRuns: {
    id: 'id',
    teamId: 'teamId',
    status: 'status',
    startedAt: 'startedAt',
    rootAgentId: 'rootAgentId',
    completedAt: 'completedAt',
    errorMessage: 'errorMessage',
  },
  teamMessages: { id: 'id', runId: 'runId', type: 'type' },
  teamTasks: { runId: 'runId', costUsd: 'costUsd' },
}));

vi.mock('@/lib/db', () => {
  const makeSelectChain = (rows: unknown[]) => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(rows),
      }),
    }),
  });
  return {
    db: {
      select: (projection?: Record<string, unknown>) => {
        if (projection && 'status' in projection) {
          return makeSelectChain([hoisted.runRow]);
        }
        if (projection && 'userId' in projection && 'id' in projection) {
          return makeSelectChain([hoisted.teamRow]);
        }
        return makeSelectChain([]);
      },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            hoisted.updateCalls.push(values);
            return undefined;
          },
        }),
      }),
    },
  };
});

vi.mock('@/lib/redis', () => ({
  getPubSubPublisher: () => ({
    publish: async () => 0,
    quit: async () => undefined,
  }),
  createPubSubSubscriber: () => ({
    subscribe: async () => undefined,
    on: () => undefined,
    quit: async () => undefined,
  }),
  // Phase B: AgentTool now imports `wake` which loads the agent-run
  // BullMQ Queue at module init; that constructor calls
  // getBullMQConnection(). Stub it here so module load doesn't crash.
  getBullMQConnection: () => ({}),
}));

vi.mock('@/tools/SendMessageTool/SendMessageTool', () => ({
  teamCancelChannel: (runId: string) => `cancel:${runId}`,
  teamInjectChannel: (runId: string) => `inject:${runId}`,
  teamMessagesChannel: (teamId: string) => `messages:${teamId}`,
}));

vi.mock('@/tools/registry-team', () => ({}));

vi.mock('@/lib/platform-deps', () => ({
  createTeamPlatformDeps: async () => ({}),
}));

vi.mock('@/lib/team-conversation', () => ({
  loadConversationHistory: async () => [],
}));

vi.mock('@/lib/team-conversation-registry', () => ({
  ensureActiveConversation: async () => 'conv-stub',
}));

vi.mock('@/tools/AgentTool/registry', async () => {
  const { makeMockAgentDefinition } = await import('./_lib/mock-agent');
  return {
    resolveAgent: async () =>
      makeMockAgentDefinition({
        name: 'coordinator',
        description: 'coord',
        model: 'm',
        maxTurns: 5,
        systemPrompt: 's',
        sourcePath: '/c.md',
      }),
    getAvailableAgents: async () => [],
  };
});

vi.mock('@/tools/AgentTool/spawn', () => ({
  buildAgentConfigFromDefinition: (def: { name: string }) => ({
    name: def.name,
    systemPrompt: 's',
    model: 'm',
    tools: [],
    maxTurns: 5,
  }),
}));

vi.mock('@/tools/AgentTool/agent-schemas', () => ({
  getAgentOutputSchema: () => null,
}));

import { processTeamRun } from '../team-run';

function makeJob(): Job {
  return {
    id: 'job-1',
    data: { runId: 'run-1', traceId: 'trace-1' },
  } as Job;
}

describe('processTeamRun — pre-flight budget check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.updateCalls.length = 0;
    hoisted.runRow.status = 'pending';
    hoisted.teamRow.productId = null;
  });

  it('aborts and marks run failed when team budget is exhausted', async () => {
    hoisted.teamHasBudgetRemainingMock.mockResolvedValueOnce(false);
    hoisted.getTeamBudgetSnapshotMock.mockResolvedValueOnce({
      teamId: 'team-1',
      weeklyBudgetUsd: 50,
      spentUsd: 51.23,
      utilization: 1.0246,
      exhausted: true,
      at90Percent: true,
    });

    await processTeamRun(makeJob());

    // runAgent must never be called — the gate must fire before any LLM work.
    expect(hoisted.runAgentMock).not.toHaveBeenCalled();

    // A failed-marker update lands with the budget error message.
    const failedUpdate = hoisted.updateCalls.find(
      (u) => u.status === 'failed',
    );
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate?.errorMessage).toMatch(/^BUDGET_EXCEEDED/);
    expect(failedUpdate?.errorMessage).toContain('$51.2300');
    expect(failedUpdate?.errorMessage).toContain('$50.00');
  });

  it('proceeds past the pre-flight when budget is available', async () => {
    hoisted.teamHasBudgetRemainingMock.mockResolvedValueOnce(true);

    // runAgent is called later in the pipeline; resolve with a trivial
    // result so the processor can complete its happy path without
    // blowing up on downstream mocks.
    hoisted.runAgentMock.mockResolvedValueOnce({
      result: 'ok',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        model: 'm',
        turns: 0,
      },
    });

    await processTeamRun(makeJob()).catch(() => {
      // Downstream steps (teamMembers lookup, etc.) aren't fully faked
      // here — we only care that the pre-flight didn't short-circuit.
    });

    // Budget check consulted the team-budget module exactly once.
    expect(hoisted.teamHasBudgetRemainingMock).toHaveBeenCalledWith(
      'team-1',
      expect.anything(),
    );
    expect(hoisted.getTeamBudgetSnapshotMock).not.toHaveBeenCalled();

    // No BUDGET_EXCEEDED failure was written.
    const budgetFailure = hoisted.updateCalls.find(
      (u) =>
        u.status === 'failed' &&
        typeof u.errorMessage === 'string' &&
        u.errorMessage.startsWith('BUDGET_EXCEEDED'),
    );
    expect(budgetFailure).toBeUndefined();
  });
});
