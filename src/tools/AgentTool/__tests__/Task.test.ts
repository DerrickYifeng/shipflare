/**
 * Task tool tests — verify input validation, agent resolution, spawn-depth
 * limit (spec §16), and tool-allowlist enforcement (sub-agent config derived
 * from AGENT.md `tools` array, NOT the full central registry).
 *
 * Strategy: mock @/core/query-loop runAgent so we can capture the AgentConfig
 * passed to it and assert on `config.tools` without running a real model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import * as path from 'node:path';
import type { AgentConfig, AgentResult, ToolContext } from '@/core/types';

const FIXTURES_ROOT = path.resolve(
  __dirname,
  'fixtures',
  'task-tool',
);

// ---------------------------------------------------------------------------
// Mock runAgent — captures the AgentConfig per call + returns a scripted result
// ---------------------------------------------------------------------------

interface MockCall {
  config: AgentConfig;
  prompt: string;
  context: ToolContext;
  outputSchema?: z.ZodType<unknown>;
}

const runAgentCalls: MockCall[] = [];
let runAgentImpl: (call: MockCall) => Promise<AgentResult<unknown>> = async () => ({
  result: 'default-mock-result',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.001,
    model: 'test',
    turns: 1,
  },
});

vi.mock('@/core/query-loop', async () => {
  const actual = await vi.importActual<typeof import('@/core/query-loop')>(
    '@/core/query-loop',
  );
  return {
    ...actual,
    runAgent: vi.fn(
      async (
        config: AgentConfig,
        prompt: string,
        context: ToolContext,
        outputSchema?: z.ZodType<unknown>,
      ) => {
        const call: MockCall = outputSchema
          ? { config, prompt, context, outputSchema }
          : { config, prompt, context };
        runAgentCalls.push(call);
        return runAgentImpl(call);
      },
    ),
  };
});

// ---------------------------------------------------------------------------
// Mock the Phase B async-branch deps BEFORE importing AgentTool. The async
// branch uses `wake()` to enqueue the agent-run BullMQ job — mocked so the
// test stays self-contained. (Phase G removed the SHIPFLARE_AGENT_TEAMS
// feature flag, so there is no flag to mock.)
// ---------------------------------------------------------------------------

vi.mock('@/workers/processors/lib/wake', () => ({
  wake: vi.fn(async () => undefined),
}));

// Import *after* vi.mock so the stub is installed before the real module
// binds runAgent via module resolution.
import {
  taskTool,
  TASK_TOOL_NAME,
  MAX_SPAWN_DEPTH,
} from '../AgentTool';
import { buildTaskDescription } from '../prompt';
import {
  __setAgentsRootForTesting,
  __resetAgentRegistry,
  getAvailableAgents,
} from '../registry';
import { wake } from '@/workers/processors/lib/wake';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolContext & { depth: number }> = {}): ToolContext {
  const ac = new AbortController();
  const base: ToolContext & { depth?: number } = {
    abortSignal: overrides.abortSignal ?? ac.signal,
    get<V>(key: string): V {
      throw new Error(`no dep ${key}`);
    },
  };
  if (overrides.depth !== undefined) {
    (base as { depth: number }).depth = overrides.depth;
  }
  return base;
}

beforeEach(() => {
  runAgentCalls.length = 0;
  __setAgentsRootForTesting(FIXTURES_ROOT);
});

afterEach(() => {
  __resetAgentRegistry();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Task tool — happy path', () => {
  it('spawns a stubbed agent and surfaces its result + cost + duration + turns', async () => {
    runAgentImpl = async () => ({
      result: 'hello back',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0042,
        model: 'claude-sonnet-4-6',
        turns: 2,
      },
    });

    const out = await taskTool.execute(
      {
        subagent_type: 'test-agent',
        prompt: 'hello',
        description: 'say hi',
      },
      makeCtx(),
    );

    expect(out.result).toBe('hello back');
    expect(out.cost).toBeCloseTo(0.0042, 6);
    expect(out.turns).toBe(2);
    expect(typeof out.duration).toBe('number');
    expect(out.duration).toBeGreaterThanOrEqual(0);
    expect(runAgentCalls).toHaveLength(1);
  });
});

describe('Task tool — input validation', () => {
  it('rejects a subagent_type that is not registered and lists valid types', async () => {
    await expect(
      taskTool.execute(
        {
          subagent_type: 'nope-never-existed',
          prompt: 'hi',
          description: 'bad delegation',
        },
        makeCtx(),
      ),
    ).rejects.toThrow(/unknown subagent_type/i);

    await expect(
      taskTool.execute(
        {
          subagent_type: 'nope-never-existed',
          prompt: 'hi',
          description: 'bad delegation',
        },
        makeCtx(),
      ),
    ).rejects.toThrow(/test-agent/);
  });

  it('rejects a description longer than 100 characters at the schema boundary', () => {
    const longDesc = 'x'.repeat(101);
    const parsed = taskTool.inputSchema.safeParse({
      subagent_type: 'test-agent',
      prompt: 'hello',
      description: longDesc,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path[0] === 'description')).toBe(
        true,
      );
    }
  });

  it('accepts a description of exactly 100 characters', () => {
    const desc = 'x'.repeat(100);
    const parsed = taskTool.inputSchema.safeParse({
      subagent_type: 'test-agent',
      prompt: 'hello',
      description: desc,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('Task tool — spawn-depth limit', () => {
  it(`throws when the caller's context is already at depth ${MAX_SPAWN_DEPTH}`, async () => {
    // Simulate "4 levels deep": the caller is already at MAX_SPAWN_DEPTH,
    // so any further Task invocation must be refused. This mirrors the
    // coordinator→A→B→C chain — C calling Task for a 4th-level spawn.
    await expect(
      taskTool.execute(
        {
          subagent_type: 'test-agent',
          prompt: 'going deeper',
          description: 'too deep',
        },
        makeCtx({ depth: MAX_SPAWN_DEPTH }),
      ),
    ).rejects.toThrow(/spawn depth limit/i);
  });

  it(`allows a spawn at depth ${MAX_SPAWN_DEPTH - 1}`, async () => {
    runAgentImpl = async () => ({
      result: 'ok',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        model: 'test',
        turns: 1,
      },
    });

    const out = await taskTool.execute(
      {
        subagent_type: 'test-agent',
        prompt: 'one more level',
        description: 'near the limit',
      },
      makeCtx({ depth: MAX_SPAWN_DEPTH - 1 }),
    );

    expect(out.result).toBe('ok');
    expect(runAgentCalls).toHaveLength(1);
  });
});

describe('Task tool — allowlist enforcement', () => {
  it("passes only the sub-agent's declared tools to runAgent, not the full registry", async () => {
    runAgentImpl = async () => ({
      result: 'ok',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        model: 'test',
        turns: 1,
      },
    });

    await taskTool.execute(
      {
        subagent_type: 'test-agent',
        prompt: 'check tools',
        description: 'allowlist test',
      },
      makeCtx(),
    );

    expect(runAgentCalls).toHaveLength(1);
    const capturedConfig = runAgentCalls[0]!.config;
    const capturedToolNames = capturedConfig.tools.map((t) => t.name).sort();

    // test-agent declares exactly these two in its AGENT.md frontmatter.
    expect(capturedToolNames).toEqual(['find_threads', 'reddit_search']);

    // And NOT any of the other tools we know are registered centrally.
    expect(capturedToolNames).not.toContain('x_post');
    expect(capturedToolNames).not.toContain('reddit_submit_post');
  });
});

describe('buildTaskDescription — roster + teaching composition', () => {
  it('embeds all 3 delegation-teaching sections AND one line per available agent', async () => {
    const agents = await getAvailableAgents();
    const desc = buildTaskDescription(agents);

    // Header + roster line per agent.
    expect(desc).toMatch(/Launch a new agent/);
    expect(desc).toMatch(/Available specialists and the tools they have access to:/);
    for (const a of agents) {
      expect(desc).toContain(`- ${a.name}: ${a.description}`);
      expect(desc).toContain('(Tools: ');
    }

    // USAGE_NOTES bullet-style parameter block.
    expect(desc).toMatch(new RegExp(`Using the ${TASK_TOOL_NAME} tool`));
    expect(desc).toMatch(/subagent_type.*required/);
    expect(desc).toMatch(/prompt.*required/);
    expect(desc).toMatch(/description.*required/);

    // delegation-teaching.md sections (WHEN_NOT_TO_USE + parallel +
    // WRITING_THE_PROMPT). These strings come directly from the .md file
    // and would regress if the composition dropped the teaching block.
    expect(desc).toMatch(/When NOT to delegate/);
    expect(desc).toMatch(/Launching in parallel/);
    expect(desc).toMatch(/Writing the Task prompt/);
  });

  it('renders a "no specialists" message when the roster is empty', () => {
    const desc = buildTaskDescription([]);
    expect(desc).toMatch(/No specialist agents are currently available/i);
    // Still embeds the teaching block so the delegator learns the rules even
    // before any specialists are registered.
    expect(desc).toMatch(/When NOT to delegate/);
  });
});

// ---------------------------------------------------------------------------
// Phase B — async branch: `run_in_background:true` flag-gated lifecycle
// ---------------------------------------------------------------------------

interface AsyncInsert {
  table: string;
  row: Record<string, unknown>;
}

const asyncInserts: AsyncInsert[] = [];

function makeFakeAsyncDb() {
  return {
    insert(table: unknown) {
      const name =
        (table as { _?: { name?: string } })?._?.name ??
        (table as { name?: string })?.name ??
        String(table);
      return {
        values(row: Record<string, unknown>) {
          asyncInserts.push({ table: name, row });
          return Promise.resolve();
        },
      };
    },
    // Sync-fallback path records team_tasks completion via db.update — make
    // the chain a no-op so the sync path can finish cleanly.
    update() {
      const builder = {
        set() {
          return builder;
        },
        where() {
          return Promise.resolve();
        },
      };
      return builder;
    },
    // Async branch never selects, but the budget check on the sync path may.
    // Provide a no-op select so it short-circuits if it ever fires.
    select() {
      const builder = {
        from() {
          return builder;
        },
        where() {
          return builder;
        },
        limit() {
          return Promise.resolve([]);
        },
        orderBy() {
          return builder;
        },
      };
      return builder;
    },
  };
}

function makeTeamRunCtx(
  deps: Record<string, unknown> = {},
): ToolContext {
  const ac = new AbortController();
  const merged = {
    db: makeFakeAsyncDb(),
    teamId: 'team-async-1',
    currentMemberId: 'mem-lead',
    runId: 'run-async-1',
    ...deps,
  };
  return {
    abortSignal: ac.signal,
    get<V>(key: string): V {
      if (key in merged) return merged[key as keyof typeof merged] as V;
      throw new Error(`no dep ${key}`);
    },
  };
}

describe('Task tool — async branch (Phase B)', () => {
  beforeEach(() => {
    asyncInserts.length = 0;
    vi.mocked(wake).mockClear();
  });

  it('returns immediately with {agentId, status:"async_launched"} when run_in_background:true and team context present', async () => {
    const result = await taskTool.execute(
      {
        subagent_type: 'test-agent',
        prompt: 'Draft 3 reply variations for the latest mention.',
        description: 'Async draft',
        run_in_background: true,
      },
      makeTeamRunCtx(),
    );

    expect(result.status).toBe('async_launched');
    expect(typeof result.agentId).toBe('string');
    expect(result.agentId!.length).toBeGreaterThan(0);
    expect(result.cost).toBe(0);
    expect(result.duration).toBe(0);
    expect(result.turns).toBe(0);
    expect(wake).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledWith(result.agentId);

    // Sanity: the async branch did NOT go down the sync path that calls runAgent.
    expect(runAgentCalls).toHaveLength(0);

    // Two inserts: agent_runs (queued) + team_messages (initial prompt mailbox).
    expect(asyncInserts).toHaveLength(2);
    const agentRunRow = asyncInserts[0]!.row;
    const mailboxRow = asyncInserts[1]!.row;
    expect(agentRunRow.id).toBe(result.agentId);
    expect(agentRunRow.teamId).toBe('team-async-1');
    expect(agentRunRow.memberId).toBe('mem-lead');
    expect(agentRunRow.agentDefName).toBe('test-agent');
    expect(agentRunRow.parentAgentId).toBeNull();
    expect(agentRunRow.status).toBe('queued');
    expect(mailboxRow.teamId).toBe('team-async-1');
    expect(mailboxRow.toAgentId).toBe(result.agentId);
    expect(mailboxRow.fromMemberId).toBe('mem-lead');
    expect(mailboxRow.content).toBe(
      'Draft 3 reply variations for the latest mention.',
    );
    expect(mailboxRow.summary).toBe('Async draft');
    expect(mailboxRow.type).toBe('user_prompt');
    expect(mailboxRow.messageType).toBe('message');
  });

  it('sets parentAgentId from callerAgentId when the agent-run ctx provides it (Phase E Task 7)', async () => {
    const result = await taskTool.execute(
      {
        subagent_type: 'test-agent',
        prompt: 'Spawn me with a parent.',
        description: 'Parent-aware async draft',
        run_in_background: true,
      },
      makeTeamRunCtx({ callerAgentId: 'agent-lead-7' }),
    );

    expect(result.status).toBe('async_launched');
    expect(typeof result.agentId).toBe('string');

    // The first insert is into agent_runs — parent_agent_id should be the
    // callerAgentId from ctx, NOT null (Phase B kludge removed).
    const agentRunRow = asyncInserts[0]!.row;
    expect(agentRunRow.id).toBe(result.agentId);
    expect(agentRunRow.parentAgentId).toBe('agent-lead-7');
  });

  it('falls back to sync path when run_in_background is unset', async () => {
    runAgentImpl = async () => ({
      result: 'sync-default',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0002,
        model: 'test',
        turns: 1,
      },
    });

    const result = await taskTool.execute(
      {
        subagent_type: 'test-agent',
        prompt: 'hello',
        description: 'no flag set',
      },
      makeTeamRunCtx(),
    );

    expect(result.status).toBeUndefined();
    expect(result.agentId).toBeUndefined();
    expect(result.result).toBe('sync-default');
    expect(wake).not.toHaveBeenCalled();
    expect(runAgentCalls).toHaveLength(1);
  });
});
