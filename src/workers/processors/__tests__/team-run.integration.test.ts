/**
 * Phase A Day 4 integration test for the team-run pipeline.
 *
 * Spec §11 Phase A Gate — verify:
 *   1. team_runs row is created + completes.
 *   2. team_messages contains: user_prompt, tool_call(Task), tool_result,
 *      tool_call(StructuredOutput), completion.
 *   3. team_tasks row for the echo-agent spawn exists.
 *   4. SSE subscribers receive every event published to
 *      `team:${teamId}:messages`.
 *
 * Strategy: drive processTeamRunInternal with in-memory fakes for db +
 * Redis pub/sub, and mock `createMessage` so we script exactly the turn
 * sequence the coordinator + echo-agent take.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { z } from 'zod';
import type { Database } from '@/lib/db';
import type { TeamRunDeps } from '../team-run';

// ---------------------------------------------------------------------------
// In-memory "tables"
// ---------------------------------------------------------------------------

interface TeamRow {
  id: string;
  userId: string;
  productId: string | null;
}
interface MemberRow {
  id: string;
  teamId: string;
  agentType: string;
  displayName: string;
}
interface RunRow {
  id: string;
  teamId: string;
  status: string;
  goal: string;
  rootAgentId: string;
  traceId: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  totalCostUsd?: string | null;
  totalTurns?: number | null;
  errorMessage?: string | null;
}
interface MessageRow {
  id: string;
  runId: string | null;
  teamId: string;
  fromMemberId: string | null;
  toMemberId: string | null;
  type: string;
  content: string | null;
  metadata: unknown;
  createdAt: Date;
}
interface TaskRow {
  id: string;
  runId: string;
  parentTaskId: string | null;
  memberId: string;
  description: string;
  prompt: string;
  input: unknown;
  output?: unknown;
  status: string;
  startedAt?: Date | null;
  completedAt?: Date | null;
  costUsd?: string | null;
  turns?: number | null;
  errorMessage?: string | null;
}

const teamsTable: TeamRow[] = [];
const membersTable: MemberRow[] = [];
const runsTable: RunRow[] = [];
const messagesTable: MessageRow[] = [];
const tasksTable: TaskRow[] = [];

// ---------------------------------------------------------------------------
// Fake drizzle-orm — intercept eq/and/desc
// ---------------------------------------------------------------------------

interface EqSentinel {
  __eq: { column: unknown; value: unknown };
}
interface AndSentinel {
  __and: Array<EqSentinel | AndSentinel>;
}
interface DescSentinel {
  __desc: unknown;
}

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: unknown, value: unknown): EqSentinel => ({
      __eq: { column: col, value },
    }),
    and: (...clauses: Array<EqSentinel | AndSentinel>): AndSentinel => ({
      __and: clauses,
    }),
    desc: (col: unknown): DescSentinel => ({ __desc: col }),
  };
});

function flatten(cond: EqSentinel | AndSentinel | undefined): unknown[] {
  if (!cond) return [];
  if ('__eq' in cond) return [cond.__eq.value];
  return cond.__and.flatMap((c) => flatten(c));
}

// ---------------------------------------------------------------------------
// Fake db — routes by table identity (schema objects are stable singletons).
// ---------------------------------------------------------------------------

function makeFakeDb(s: typeof import('@/lib/db/schema')): Database {
  function selectRows(table: unknown): unknown[] {
    if (table === s.teamRuns) return runsTable;
    if (table === s.teams) return teamsTable;
    if (table === s.teamMembers) return membersTable;
    if (table === s.teamMessages) return messagesTable;
    if (table === s.teamTasks) return tasksTable;
    throw new Error('unknown select table');
  }

  const db = {
    select(_cols?: unknown) {
      let table: unknown = null;
      let filter: EqSentinel | AndSentinel | undefined;
      const builder = {
        from(t: unknown) {
          table = t;
          return builder;
        },
        where(c: EqSentinel | AndSentinel) {
          filter = c;
          return builder;
        },
        orderBy(..._args: unknown[]) {
          return builder;
        },
        limit(n: number): Promise<unknown[]> {
          const rows = selectRows(table);
          const values = flatten(filter);
          const matches = rows.filter((row) => {
            const r = row as Record<string, unknown>;
            return values.every((v) =>
              [
                r.id,
                r.teamId,
                r.displayName,
                r.agentType,
                r.status,
                r.runId,
              ].includes(v),
            );
          });
          return Promise.resolve(matches.slice(0, n));
        },
        // Chainable .where(...) without .limit() must also be awaitable.
        then(resolve: (v: unknown[]) => unknown) {
          const rows = selectRows(table);
          const values = flatten(filter);
          const matches = rows.filter((row) => {
            const r = row as Record<string, unknown>;
            return values.every((v) =>
              [
                r.id,
                r.teamId,
                r.displayName,
                r.agentType,
                r.status,
                r.runId,
              ].includes(v),
            );
          });
          return Promise.resolve(matches).then(resolve);
        },
      };
      return builder;
    },
    insert(table: unknown) {
      return {
        values(row: Record<string, unknown>) {
          if (table === s.teamMessages) {
            messagesTable.push(row as unknown as MessageRow);
          } else if (table === s.teamRuns) {
            runsTable.push(row as unknown as RunRow);
          } else if (table === s.teamTasks) {
            tasksTable.push(row as unknown as TaskRow);
          } else {
            throw new Error('unknown insert table');
          }
          return Promise.resolve();
        },
      };
    },
    update(table: unknown) {
      let patch: Record<string, unknown> = {};
      const builder = {
        set(p: Record<string, unknown>) {
          patch = p;
          return builder;
        },
        where(c: EqSentinel | AndSentinel) {
          const targetId = flatten(c).find((v) => typeof v === 'string');
          const list: Array<{ id: string }> | null =
            table === s.teamRuns
              ? runsTable
              : table === s.teamTasks
                ? tasksTable
                : null;
          if (!list) return Promise.resolve();
          const row = list.find((r) => r.id === targetId);
          if (row) Object.assign(row, patch);
          return Promise.resolve();
        },
      };
      return builder;
    },
  } as unknown as Database;
  return db;
}

// ---------------------------------------------------------------------------
// Fake pub/sub — records every call
// ---------------------------------------------------------------------------

const published: Array<{ channel: string; payload: Record<string, unknown> }> = [];

function makePublish(): TeamRunDeps['publish'] {
  return async (channel, payload) => {
    published.push({ channel, payload });
  };
}

// ---------------------------------------------------------------------------
// Module mocks — must precede any import that closes over them
// ---------------------------------------------------------------------------

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

vi.mock('@/lib/db', async () => {
  const schema = await import('@/lib/db/schema');
  return { db: makeFakeDb(schema) };
});

vi.mock('@/lib/redis', () => ({
  getPubSubPublisher: () => ({
    publish: async () => 1,
  }),
  createPubSubSubscriber: () => ({
    subscribe: async () => {},
    on: () => {},
    unsubscribe: async () => {},
    disconnect: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Scripted createMessage
// ---------------------------------------------------------------------------

interface ScriptedResponse {
  content: Array<
    | { type: 'text'; text: string }
    | {
        type: 'tool_use';
        id: string;
        name: string;
        input: Record<string, unknown>;
      }
  >;
  stop_reason: 'tool_use' | 'end_turn';
}

const script: ScriptedResponse[] = [];

vi.mock('@/core/api-client', async () => {
  const actual =
    await vi.importActual<typeof import('@/core/api-client')>(
      '@/core/api-client',
    );
  return {
    ...actual,
    createMessage: vi.fn(async () => {
      const next = script.shift();
      if (!next) {
        throw new Error(
          'script exhausted — test did not enqueue enough responses',
        );
      }
      return {
        response: {
          id: `msg_${Math.random().toString(36).slice(2)}`,
          type: 'message' as const,
          role: 'assistant' as const,
          model: 'test',
          stop_reason: next.stop_reason,
          stop_sequence: null,
          content: next.content,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    }),
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  __setAgentsRootForTesting,
  __resetAgentRegistry,
} from '@/tools/AgentTool/registry';
// Register Task + SendMessage in the central registry before the processor
// resolves them against AGENT.md tool allowlists.
import '@/tools/registry-team';
import { processTeamRunInternal } from '../team-run';

const FIXTURES_ROOT = path.resolve(__dirname, 'team-run-fixtures');

beforeEach(() => {
  teamsTable.length = 0;
  membersTable.length = 0;
  runsTable.length = 0;
  messagesTable.length = 0;
  tasksTable.length = 0;
  published.length = 0;
  script.length = 0;
  __setAgentsRootForTesting(FIXTURES_ROOT);
});

afterEach(() => {
  __resetAgentRegistry();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The Phase A Day 4 gate
// ---------------------------------------------------------------------------

describe('Phase A Day 4 — team-run integration', () => {
  it('drives coordinator → Task(echo-agent) → StructuredOutput end-to-end', async () => {
    // --- Seed in-memory state ---
    teamsTable.push({ id: 'team-1', userId: 'user-1', productId: null });
    membersTable.push({
      id: 'mem-coord',
      teamId: 'team-1',
      agentType: 'coordinator-test',
      displayName: 'Sam (coordinator)',
    });
    runsTable.push({
      id: 'run-1',
      teamId: 'team-1',
      status: 'pending',
      goal: 'Echo the greeting',
      rootAgentId: 'mem-coord',
      traceId: 'trace-1',
    });

    // --- Script the turns ---
    //
    // With `rootOutputSchema` set below, the coordinator's runAgent
    // synthesizes a `StructuredOutput` tool. Its final turn calls that
    // tool, which runAgent intercepts, validates, and surfaces via
    // onEvent (tool_start/tool_done) — the processor mirrors both into
    // team_messages.
    //
    //   Turn 1 (coordinator): Task(echo-agent, ...)
    //   Turn 2 (echo-agent nested runAgent): plain text stub (echo-agent
    //     has no outputSchema, tools=[], so end_turn with text is the
    //     expected exit).
    //   Turn 3 (coordinator after tool_result): StructuredOutput terminal.

    script.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_task_1',
          name: 'Task',
          input: {
            subagent_type: 'echo-agent',
            prompt: 'say hi',
            description: 'echo test',
          },
        },
      ],
      stop_reason: 'tool_use',
    });
    // Echo-agent returns a text response; spawnSubagent passes undefined
    // outputSchema so the nested runAgent returns the text as `result`.
    script.push({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
    });
    // Coordinator's final turn — StructuredOutput is synthesized.
    script.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_so_coord',
          name: 'StructuredOutput',
          input: {
            status: 'completed',
            summary: 'echo done',
          },
        },
      ],
      stop_reason: 'tool_use',
    });

    // --- Drive the processor ---
    const schema = await import('@/lib/db/schema');
    const deps: TeamRunDeps = {
      db: makeFakeDb(schema),
      publish: makePublish(),
    };

    const rootSchema = z.object({
      status: z.string(),
      summary: z.string(),
    });

    await processTeamRunInternal('run-1', deps, () => {}, rootSchema);

    // ------------------------------------------------------------------
    // Phase A Gate assertions (spec §11 Phase A Day 4)
    // ------------------------------------------------------------------

    // 1. team_runs row completed.
    const run = runsTable.find((r) => r.id === 'run-1');
    expect(run).toBeDefined();
    expect(run!.status).toBe('completed');
    expect(run!.completedAt).toBeInstanceOf(Date);

    // 2. team_messages contains the expected sequence.
    const types = messagesTable.map((m) => m.type);
    expect(types[0]).toBe('user_prompt');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types[types.length - 1]).toBe('completion');

    const toolCalls = messagesTable.filter((m) => m.type === 'tool_call');
    const toolNames = toolCalls
      .map((m) => (m.metadata as Record<string, unknown> | null)?.toolName)
      .filter((n): n is string => typeof n === 'string');
    expect(toolNames).toContain('Task');
    expect(toolNames).toContain('StructuredOutput');

    // 3. team_tasks row for the echo-agent spawn.
    const tasks = tasksTable.filter((t) => t.runId === 'run-1');
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks[0].description).toBe('echo test');
    expect(tasks[0].prompt).toBe('say hi');
    expect((tasks[0].input as Record<string, unknown>).subagent_type).toBe(
      'echo-agent',
    );
    expect(tasks[0].status).toBe('completed');

    // 4. SSE pub/sub delivered events.
    //    Every team_messages insert publishes a matching payload; the
    //    channel constant is stable.
    expect(published.length).toBe(messagesTable.length);
    const channels = new Set(published.map((p) => p.channel));
    expect(Array.from(channels)).toEqual(['team:team-1:messages']);
    // The final completion payload carries the final summary.
    const completionEvent = published[published.length - 1].payload;
    expect(completionEvent.type).toBe('completion');
  });

  it('propagates onEvent through 2-level Task spawns with parentTaskId tagging', async () => {
    // Phase D prerequisite (Task #10): when the coordinator spawns
    // echo-agent-a, and echo-agent-a spawns echo-agent-b, every tool_call
    // emitted inside the specialist subagents must land in team_messages
    // with metadata.parentTaskId pointing at the nearest enclosing
    // team_tasks.id — so the activity-log UI can render a complete tree.

    // Point the agent registry at the nested-fixture directory for the
    // rest of this test. `afterEach` resets it.
    __setAgentsRootForTesting(
      path.resolve(__dirname, 'team-run-nested-fixtures'),
    );
    __resetAgentRegistry();

    // --- Seed state ---
    teamsTable.push({ id: 'team-n', userId: 'user-n', productId: null });
    membersTable.push({
      id: 'mem-coord-n',
      teamId: 'team-n',
      agentType: 'coordinator-nested',
      displayName: 'Sam (coordinator)',
    });
    membersTable.push({
      id: 'mem-echo-a',
      teamId: 'team-n',
      agentType: 'echo-agent-a',
      displayName: 'Echo A',
    });
    membersTable.push({
      id: 'mem-echo-b',
      teamId: 'team-n',
      agentType: 'echo-agent-b',
      displayName: 'Echo B',
    });
    runsTable.push({
      id: 'run-nested',
      teamId: 'team-n',
      status: 'pending',
      goal: 'Nested echo',
      rootAgentId: 'mem-coord-n',
      traceId: null,
    });

    // --- Script ---
    //   Turn 1 (coordinator-nested): Task(echo-agent-a, ...)
    //   Turn 2 (echo-agent-a):       Task(echo-agent-b, ...)
    //   Turn 3 (echo-agent-b):       text end_turn
    //   Turn 4 (echo-agent-a):       text end_turn (after tool_result)
    //   Turn 5 (coordinator-nested): StructuredOutput terminal

    script.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_a',
          name: 'Task',
          input: {
            subagent_type: 'echo-agent-a',
            prompt: 'level 1',
            description: 'spawn A',
          },
        },
      ],
      stop_reason: 'tool_use',
    });
    script.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_b',
          name: 'Task',
          input: {
            subagent_type: 'echo-agent-b',
            prompt: 'level 2',
            description: 'spawn B',
          },
        },
      ],
      stop_reason: 'tool_use',
    });
    script.push({
      content: [{ type: 'text', text: 'leaf' }],
      stop_reason: 'end_turn',
    });
    script.push({
      content: [{ type: 'text', text: 'A done' }],
      stop_reason: 'end_turn',
    });
    script.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_so_nested',
          name: 'StructuredOutput',
          input: { status: 'completed', summary: 'nested echo done' },
        },
      ],
      stop_reason: 'tool_use',
    });

    const schema = await import('@/lib/db/schema');
    const deps: TeamRunDeps = {
      db: makeFakeDb(schema),
      publish: makePublish(),
    };
    const rootSchema = z.object({
      status: z.string(),
      summary: z.string(),
    });

    await processTeamRunInternal('run-nested', deps, () => {}, rootSchema);

    // --- 1. team_runs completed ---
    const run = runsTable.find((r) => r.id === 'run-nested');
    expect(run?.status).toBe('completed');

    // --- 2. team_tasks: expect TWO task rows (A + B) chained ---
    const tasks = tasksTable.filter((t) => t.runId === 'run-nested');
    expect(tasks).toHaveLength(2);
    const taskA = tasks.find(
      (t) => (t.input as Record<string, unknown>).subagent_type === 'echo-agent-a',
    );
    const taskB = tasks.find(
      (t) => (t.input as Record<string, unknown>).subagent_type === 'echo-agent-b',
    );
    expect(taskA).toBeDefined();
    expect(taskB).toBeDefined();
    // taskA's parent is the coordinator (null); taskB's parent is taskA.
    expect(taskA!.parentTaskId).toBeNull();
    expect(taskB!.parentTaskId).toBe(taskA!.id);

    // --- 3. team_messages attribution ---
    //
    // Every tool_call / tool_result emitted INSIDE echo-agent-a's run must
    // carry metadata.parentTaskId === taskA.id and fromMemberId === 'mem-echo-a'.
    // (That includes the Task(echo-agent-b) call and its tool_result, but
    // NOT the outer Task(echo-agent-a) call — that one is attributed to
    // the coordinator.)
    const toolMessages = messagesTable.filter(
      (m) => m.type === 'tool_call' || m.type === 'tool_result',
    );

    const coordinatorTaskCalls = toolMessages.filter(
      (m) =>
        (m.metadata as Record<string, unknown>).toolName === 'Task' &&
        m.fromMemberId === 'mem-coord-n',
    );
    expect(coordinatorTaskCalls.length).toBeGreaterThan(0);
    for (const msg of coordinatorTaskCalls) {
      // The outermost Task call has no spawnMeta — it runs at the
      // coordinator scope, not inside a spawn.
      expect(
        (msg.metadata as Record<string, unknown>).parentTaskId,
      ).toBeUndefined();
    }

    const aScopedTaskCalls = toolMessages.filter(
      (m) =>
        (m.metadata as Record<string, unknown>).toolName === 'Task' &&
        m.fromMemberId === 'mem-echo-a',
    );
    expect(aScopedTaskCalls.length).toBeGreaterThan(0);
    for (const msg of aScopedTaskCalls) {
      expect((msg.metadata as Record<string, unknown>).parentTaskId).toBe(
        taskA!.id,
      );
      expect((msg.metadata as Record<string, unknown>).agentName).toBe(
        'echo-agent-a',
      );
    }

    // --- 4. Pub/sub parity ---
    expect(published.length).toBe(messagesTable.length);
  });

  it('skips the run idempotently when the team_runs row is no longer pending', async () => {
    runsTable.push({
      id: 'run-already-done',
      teamId: 'team-1',
      status: 'completed',
      goal: 'noop',
      rootAgentId: 'mem-coord',
      traceId: null,
    });

    const schema = await import('@/lib/db/schema');
    const deps: TeamRunDeps = {
      db: makeFakeDb(schema),
      publish: makePublish(),
    };

    await processTeamRunInternal('run-already-done', deps);
    // Nothing inserted, status unchanged.
    expect(messagesTable).toHaveLength(0);
    expect(published).toHaveLength(0);
    expect(
      runsTable.find((r) => r.id === 'run-already-done')!.status,
    ).toBe('completed');
  });
});
