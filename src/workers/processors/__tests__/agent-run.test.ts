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

vi.mock('@/core/query-loop', () => ({
  runAgent: vi.fn(async () => ({
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
  })),
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

function makeJob(agentId: string): Job<AgentRunJobData> {
  return { id: 'job-1', data: { agentId } } as unknown as Job<AgentRunJobData>;
}

describe('processAgentRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateChain.set.mockClear();
    updateChain.where.mockClear();
    insertChain.values.mockClear();
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
});
