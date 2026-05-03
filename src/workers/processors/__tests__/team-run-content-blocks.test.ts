/**
 * Write-path coverage for the Phase 2b `team_messages.content_blocks`
 * column. Confirms `deriveContentBlocks` produces Anthropic-native
 * ContentBlockParam arrays that the history loader can concat by role
 * without re-deriving anything from `content` / `metadata`.
 *
 * The derive function is internal to team-run.ts so we exercise it
 * through a minimal mock of `recordMessage`'s insert path — we only
 * need to verify the VALUES passed to drizzle include a
 * `contentBlocks` field shaped the right way per row type.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';

const hoisted = vi.hoisted(() => ({
  insertedValues: [] as Array<Record<string, unknown>>,
  teamRow: { id: 'team-1', userId: 'user-1', productId: null as string | null },
  runRow: {
    id: 'run-1',
    teamId: 'team-1',
    conversationId: 'conv-1',
    status: 'pending' as string,
    goal: 'test',
    rootAgentId: 'mem-1',
    traceId: 't',
  },
  memberRow: {
    id: 'mem-1',
    teamId: 'team-1',
    agentType: 'coordinator',
    displayName: 'Coord',
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
  teamHasBudgetRemaining: async () => true,
  getTeamBudgetSnapshot: vi.fn(),
  maybeEmitBudgetWarning: async () => undefined,
}));

vi.mock('@/lib/platform-deps', () => ({
  createTeamPlatformDeps: async () => ({}),
}));

vi.mock('@/lib/team-conversation', () => ({
  loadConversationHistory: async () => [],
}));

vi.mock('@/lib/team-conversation-registry', () => ({
  ensureActiveConversation: async () => 'conv-1',
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
    conversationId: 'conversationId',
    status: 'status',
    startedAt: 'startedAt',
    rootAgentId: 'rootAgentId',
    completedAt: 'completedAt',
    errorMessage: 'errorMessage',
  },
  teamMessages: {
    id: 'id',
    runId: 'runId',
    type: 'type',
    conversationId: 'conversationId',
  },
  teamTasks: { runId: 'runId', costUsd: 'costUsd' },
}));

vi.mock('@/lib/db', () => {
  // Build a tolerant chain: every possible drizzle terminator (limit
  // / await / orderBy) resolves to rows. We use a thenable + methods
  // so `await chain` and `await chain.limit(1)` both work for the
  // various query shapes in team-run.
  function makeSelectChain(rows: unknown[]) {
    const thenable = {
      limit: async () => rows,
      orderBy: () => thenable,
      then: (resolve: (v: unknown) => void) => resolve(rows),
    };
    return { from: () => ({ where: () => thenable }) };
  }

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
          return makeSelectChain([hoisted.memberRow]);
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
        values: (row: Record<string, unknown>) => {
          hoisted.insertedValues.push(row);
          return Promise.resolve(undefined);
        },
      }),
    },
  };
});

vi.mock('@/lib/redis', () => ({
  getPubSubPublisher: () => ({ publish: async () => 0, quit: async () => undefined }),
  createPubSubSubscriber: () => ({ subscribe: async () => undefined, on: () => undefined, quit: async () => undefined }),
}));

vi.mock('@/tools/SendMessageTool/SendMessageTool', () => ({
  teamCancelChannel: () => 'c',
  teamInjectChannel: () => 'i',
  teamMessagesChannel: () => 'm',
}));

vi.mock('@/tools/registry-team', () => ({}));

vi.mock('@/tools/AgentTool/registry', async () => {
  const { makeMockAgentDefinition } = await import('./_lib/mock-agent');
  return {
    resolveAgent: async () =>
      makeMockAgentDefinition({
        name: 'coordinator',
        description: 'x',
        model: 'm',
        maxTurns: 5,
        systemPrompt: 's',
        sourcePath: '/c.md',
      }),
    getAvailableAgents: async () => [],
  };
});

vi.mock('@/tools/AgentTool/spawn', () => ({
  buildAgentConfigFromDefinition: () => ({
    name: 'coordinator',
    systemPrompt: 's',
    model: 'm',
    tools: [],
    maxTurns: 5,
  }),
}));

vi.mock('@/tools/AgentTool/agent-schemas', () => ({
  getAgentOutputSchema: () => null,
}));

vi.mock('@/tools/AgentTool/prompt', () => ({
  buildTaskDescription: () => 'roster',
}));

vi.mock('@/tools/AgentTool/AgentTool', () => ({
  TASK_TOOL_NAME: 'Task',
}));

vi.mock('@/core/query-loop', () => ({
  runAgent: async () => ({
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
  }),
  createToolContext: (deps: Record<string, unknown>) => ({
    abortSignal: new AbortController().signal,
    get: (k: string) => deps[k],
  }),
}));

import { processTeamRun } from '../team-run';

function makeJob(): Job {
  return { id: 'job-1', data: { runId: 'run-1', traceId: 't' } } as Job;
}

describe('Phase 2b — contentBlocks on team_messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.insertedValues.length = 0;
    hoisted.updateCalls.length = 0;
    hoisted.runRow.status = 'pending';
    hoisted.runRow.conversationId = 'conv-1';
  });

  function pickMessageInserts() {
    return hoisted.insertedValues.filter((v) => typeof v.type === 'string');
  }

  it('writes the user_prompt row with a single text content block', async () => {
    await processTeamRun(makeJob()).catch(() => undefined);
    const row = pickMessageInserts().find((v) => v.type === 'user_prompt');
    expect(row).toBeDefined();
    expect(row?.contentBlocks).toEqual([{ type: 'text', text: 'test' }]);
  });

  it('writes the completion row with a single text content block', async () => {
    await processTeamRun(makeJob()).catch(() => undefined);
    const row = pickMessageInserts().find((v) => v.type === 'completion');
    expect(row).toBeDefined();
    const blocks = row?.contentBlocks as Array<{ type: string; text?: string }>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks?.[0]?.type).toBe('text');
  });

  it('populates contentBlocks AND keeps legacy content/metadata fields', async () => {
    await processTeamRun(makeJob()).catch(() => undefined);
    const row = pickMessageInserts().find((v) => v.type === 'user_prompt');
    expect(row?.content).toBe('test');
    expect(row?.contentBlocks).toBeDefined();
    expect(row?.metadata).toBeDefined();
  });
});
