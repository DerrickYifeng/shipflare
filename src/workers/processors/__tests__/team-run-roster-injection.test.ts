/**
 * Verifies that processTeamRun injects the live agent roster into the
 * Task tool's `description` field before invoking runAgent.
 *
 * Regression guard for the "coordinator hallucinates subagent_type" bug:
 * without this injection, `taskTool.description` is a static string that
 * names zero specialists, so the delegator has to guess names from its
 * AGENT.md references and misses any agent that's been added without
 * updating those references (e.g. discovery-scout / discovery-reviewer).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';

const hoisted = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  updateCalls: [] as Array<Record<string, unknown>>,
  teamRow: { id: 'team-1', userId: 'user-1', productId: null as string | null },
  runRow: {
    id: 'run-1',
    teamId: 'team-1',
    conversationId: 'conv-1' as string | null,
    status: 'pending',
    goal: 'test goal',
    rootAgentId: 'mem-1',
    traceId: 'trace-1',
  },
  memberRow: {
    id: 'mem-1',
    teamId: 'team-1',
    agentType: 'coordinator',
    displayName: 'Test',
  },
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

// Keep the live registry + real buildTaskDescription — that's the
// whole point: the test walks the actual production wiring end-to-end.
vi.mock('@/lib/team-budget', () => ({
  teamHasBudgetRemaining: async () => true,
  getTeamBudgetSnapshot: vi.fn(),
  maybeEmitBudgetWarning: async () => undefined,
}));

vi.mock('@/core/query-loop', () => ({
  runAgent: hoisted.runAgentMock,
  createToolContext: (deps: Record<string, unknown>) => ({
    abortSignal: new AbortController().signal,
    get: (k: string) => deps[k],
  }),
}));

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
      where: () => ({ limit: () => Promise.resolve(rows) }),
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
        if (
          projection &&
          'agentType' in projection &&
          'displayName' in projection
        ) {
          // teamMembers query
          return {
            from: () => ({
              where: () => Promise.resolve([hoisted.memberRow]),
            }),
          };
        }
        if (projection && 'id' in projection && !('userId' in projection)) {
          // user_prompt existence check
          return makeSelectChain([]);
        }
        return makeSelectChain([]);
      },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            hoisted.updateCalls.push(values);
          },
        }),
      }),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: async () => undefined,
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
}));

vi.mock('@/tools/SendMessageTool/SendMessageTool', () => ({
  teamCancelChannel: (runId: string) => `cancel:${runId}`,
  teamInjectChannel: (runId: string) => `inject:${runId}`,
  teamMessagesChannel: (teamId: string) => `messages:${teamId}`,
}));

vi.mock('@/tools/registry-team', () => ({}));

vi.mock('@/tools/AgentTool/agent-schemas', () => ({
  getAgentOutputSchema: () => null,
}));

vi.mock('@/lib/platform-deps', () => ({
  createTeamPlatformDeps: async () => ({}),
}));

vi.mock('@/lib/team-conversation', () => ({
  loadConversationHistory: async () => [],
}));

vi.mock('@/lib/team-conversation-registry', () => ({
  ensureActiveConversation: async () => 'conv-stub',
}));

// Mock the AgentDefinition resolution so we don't need an on-disk
// `coordinator` AGENT.md for the unit-test run. We still use the REAL
// getAvailableAgents so the roster reflects the repo state.
vi.mock('@/tools/AgentTool/registry', async () => {
  const actual = await vi.importActual<
    typeof import('@/tools/AgentTool/registry')
  >('@/tools/AgentTool/registry');
  return {
    ...actual,
    resolveAgent: async () => ({
      name: 'coordinator',
      description: 'test coord',
      tools: ['Task'],
      skills: [],
      model: 'm',
      maxTurns: 5,
      systemPrompt: 's',
      sourcePath: '/c.md',
    }),
  };
});

// Supply a stub Task tool so buildAgentConfigFromDefinition returns
// a tools list that includes it — the injection code only fires when
// Task is present.
vi.mock('@/tools/AgentTool/spawn', () => ({
  buildAgentConfigFromDefinition: () => ({
    name: 'coordinator',
    systemPrompt: 's',
    model: 'm',
    maxTurns: 5,
    tools: [
      {
        name: 'Task',
        description: 'STATIC_PLACEHOLDER',
        inputSchema: {},
        execute: async () => ({}),
        isConcurrencySafe: false,
        isReadOnly: false,
        maxResultSizeChars: 1000,
      },
    ],
  }),
}));

import { processTeamRun } from '../team-run';

function makeJob(): Job {
  return { id: 'job-1', data: { runId: 'run-1', traceId: 'trace-1' } } as Job;
}

describe('processTeamRun — Task roster injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.updateCalls.length = 0;
    hoisted.runRow.status = 'pending';
  });

  it('replaces the Task tool description with the live agent roster', async () => {
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
      /* downstream steps not fully mocked — we only care about runAgent's input */
    });

    expect(hoisted.runAgentMock).toHaveBeenCalled();
    const config = hoisted.runAgentMock.mock.calls[0]![0] as {
      tools: Array<{ name: string; description: string }>;
    };
    const taskTool = config.tools.find((t) => t.name === 'Task');
    expect(taskTool).toBeDefined();

    // Injection must replace the static placeholder with the live
    // buildTaskDescription output.
    expect(taskTool?.description).not.toBe('STATIC_PLACEHOLDER');
    expect(taskTool?.description).toMatch(
      /Available specialists and the tools they have access to/,
    );

    // Every agent present on disk (registered via AGENT.md) should
    // appear in the injected roster. discovery-agent is the canonical
    // discovery specialist — assert it by name. (Phase J Task 2
    // retired post-writer; content-manager handles original posts in
    // post_batch mode now.)
    expect(taskTool?.description).toContain('- discovery-agent:');
    expect(taskTool?.description).toContain('- content-manager:');
    expect(taskTool?.description).not.toContain('- post-writer:');
  });
});
