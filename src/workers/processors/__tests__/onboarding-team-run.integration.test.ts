/**
 * Phase B Day 4 integration test — spec §11 Phase B Gate.
 *
 * End-to-end team run drives the REAL AGENT.md files
 * (coordinator / growth-strategist / content-planner) through a scripted
 * onboarding flow:
 *
 *   Coordinator turn 1 → Task(growth-strategist, "design path")
 *     growth-strategist → write_strategic_path(...) → StructuredOutput
 *   Coordinator turn 2 → Task(content-planner, "plan week 1")
 *     content-planner → add_plan_item × 5 → StructuredOutput
 *   Coordinator turn 3 → StructuredOutput (terminal)
 *
 * Assertions (spec §11 Phase B Gate):
 *   - team_runs row status='completed'
 *   - strategic_paths row written with non-null pillars
 *   - plan_items rows ≥ 5 with non-null scheduledAt
 *   - team_messages contain tool_call(Task) × 2 + tool_call(StructuredOutput) × 3
 *
 * Strategy: in-memory DB from `src/lib/test-utils/in-memory-db.ts`
 * + scripted createMessage + fake Redis pub/sub. The processor uses the
 * production agent loader pointed at `src/tools/AgentTool/agents/` — no
 * fixture AGENT.md files involved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import {
  createInMemoryStore,
  drizzleMockFactory,
} from '@/lib/test-utils/in-memory-db';

// ---------------------------------------------------------------------------
// Module mocks
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
  loggerForRequest: () => ({
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    traceId: 'test-trace',
  }),
}));

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return drizzleMockFactory(actual);
});

// Store is created lazily and referenced via `dbProxy` so the factory
// below doesn't close over anything uninitialized.
let storeRef: ReturnType<typeof createInMemoryStore> | null = null;
function getStore(): ReturnType<typeof createInMemoryStore> {
  if (storeRef === null) storeRef = createInMemoryStore();
  return storeRef;
}

vi.mock('@/lib/db', () => {
  // Return an object whose `db` property is a getter — mocks are hoisted
  // but the getter body isn't evaluated until `db` is accessed, by which
  // point `getStore()` can safely run.
  return {
    get db() {
      return getStore().db;
    },
  };
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
  getBullMQConnection: () => ({ on: () => {} }),
}));

// Scripted Anthropic API for deterministic turns.
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
          `script exhausted — ${messagesSent} messages sent, test did not enqueue enough responses`,
        );
      }
      messagesSent += 1;
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

let messagesSent = 0;

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import {
  teams,
  teamMembers,
  teamRuns,
  teamMessages,
  teamTasks,
  products,
  plans,
  strategicPaths,
  planItems,
} from '@/lib/db/schema';
// Register all domain tools + team runtime tools.
import '@/tools/registry';
import '@/tools/registry-team';
import { processTeamRunInternal } from '../team-run';
import {
  __resetAgentRegistry,
  __setAgentsRootForTesting,
} from '@/tools/AgentTool/registry';

const PRODUCTION_AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

beforeEach(() => {
  // Reset in-memory tables.
  getStore().tables.clear();
  script.length = 0;
  messagesSent = 0;
  // Point the registry at the production agents dir so the real
  // coordinator / growth-strategist / content-planner AGENT.md files drive
  // the pipeline.
  __setAgentsRootForTesting(PRODUCTION_AGENTS_ROOT);
});

afterEach(() => {
  __resetAgentRegistry();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Phase B Day 4 gate
// ---------------------------------------------------------------------------

describe('Phase B Day 4 — onboarding team-run end-to-end', () => {
  it('coordinator → growth-strategist → content-planner produces strategic_path + plan_items', async () => {
    // --- Seed DB state ---
    const userId = 'user-1';
    const productId = 'prod-1';
    const teamId = 'team-1';
    const coordId = 'mem-coord';
    const gsId = 'mem-gs';
    const cpId = 'mem-cp';
    const runId = 'run-1';
    const planId = 'plan-1';

    getStore().get(products).push({
      id: productId,
      userId,
      name: 'TestProduct',
      description: 'A test dev tool',
      category: 'dev_tool',
      state: 'mvp',
      launchDate: null,
      launchedAt: null,
      keywords: ['test'],
      valueProp: 'Testing is fun',
      url: null,
      targetAudience: 'devs',
    });

    getStore().get(plans).push({
      id: planId,
      userId,
      productId,
      strategicPathId: null,
      trigger: 'onboarding',
      weekStart: new Date('2026-04-20T00:00:00.000Z'),
      generatedAt: new Date(),
      notes: null,
      usageSummary: null,
    });

    getStore().get(teams).push({
      id: teamId,
      userId,
      productId,
      name: 'Test Team',
      config: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    getStore().get(teamMembers).push(
      {
        id: coordId,
        teamId,
        agentType: 'coordinator',
        displayName: 'Sam',
        status: 'idle',
        lastActiveAt: null,
        createdAt: new Date(),
      },
      {
        id: gsId,
        teamId,
        agentType: 'growth-strategist',
        displayName: 'Alex',
        status: 'idle',
        lastActiveAt: null,
        createdAt: new Date(),
      },
      {
        id: cpId,
        teamId,
        agentType: 'content-planner',
        displayName: 'Maya',
        status: 'idle',
        lastActiveAt: null,
        createdAt: new Date(),
      },
    );

    getStore().get(teamRuns).push({
      id: runId,
      teamId,
      trigger: 'onboarding',
      goal: 'Plan the launch strategy for TestProduct. State: mvp. Channels: x.',
      rootAgentId: coordId,
      status: 'pending',
      startedAt: new Date(),
      completedAt: null,
      totalCostUsd: null,
      totalTurns: 0,
      traceId: 'trace-1',
      errorMessage: null,
    });

    // --- Script the agent turns ---
    //
    // Coordinator turn 1 — spawn growth-strategist.
    script.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_task_gs',
          name: 'Task',
          input: {
            subagent_type: 'growth-strategist',
            description: 'Design launch path',
            prompt:
              'Design the strategic path for TestProduct (state=mvp). Channels: x. Category: dev_tool.',
          },
        },
      ],
      stop_reason: 'tool_use',
    });

    // growth-strategist turn 1 — write the strategic path.
    script.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_write_path',
          name: 'write_strategic_path',
          input: {
            narrative:
              'We are building TestProduct for indie devs drowning in marketing debt. ' +
              'The next six weeks argue one thesis: shipping and telling the world about ' +
              'what you shipped should take the same amount of time. Week one plants ' +
              'that claim; week two defends it with data; week three names the anti-pattern; ' +
              'weeks four through six compound on case studies. The risk is over-claiming ' +
              'without enough data; we hedge by pinning every data post to a specific ' +
              'shipped commit.',
            milestones: [
              {
                atDayOffset: -28,
                title: '100 waitlist signups',
                successMetric: 'waitlist count >= 100',
                phase: 'audience',
              },
              {
                atDayOffset: -14,
                title: '10 customer interviews',
                successMetric: 'interview count >= 10',
                phase: 'audience',
              },
              {
                atDayOffset: 0,
                title: 'Ship on Product Hunt',
                successMetric: 'PH post goes live',
                phase: 'launch',
              },
            ],
            thesisArc: [
              {
                weekStart: '2026-04-20T00:00:00.000Z',
                theme: 'Indie devs waste hours on PR review',
                angleMix: ['data', 'contrarian', 'howto'],
              },
              {
                weekStart: '2026-04-27T00:00:00.000Z',
                theme: 'The 6-hour tax on indie teams',
                angleMix: ['story', 'data', 'case'],
              },
            ],
            contentPillars: [
              'build-in-public',
              'tooling-counterfactuals',
              'solo-dev-ops',
            ],
            channelMix: {
              x: { perWeek: 4, preferredHours: [14, 17, 21] },
            },
            phaseGoals: {
              audience: 'Grow from 50 to 500 waitlist',
              launch: 'Top 5 on Product Hunt',
            },
          },
        },
      ],
      stop_reason: 'tool_use',
    });

    // growth-strategist turn 2 — StructuredOutput after write succeeded.
    script.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_gs_so',
          name: 'StructuredOutput',
          input: {
            status: 'completed',
            pathId: 'resolved-at-runtime', // tool result carries the real id; we don't check this field
            summary:
              'Strategic path written with 3 pillars, 3 milestones, 2-week arc.',
            notes: 'Week 1 leans data + howto; week 2 shifts to case + story.',
          },
        },
      ],
      stop_reason: 'tool_use',
    });

    // Coordinator turn 2 — spawn content-planner.
    script.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_task_cp',
          name: 'Task',
          input: {
            subagent_type: 'content-planner',
            description: 'Plan week 1',
            prompt:
              'Plan the week of 2026-04-20 using the active path. Channels: x.',
          },
        },
      ],
      stop_reason: 'tool_use',
    });

    // content-planner turn 1 — add 5 plan_items in parallel.
    const baseWeek = '2026-04-2';
    script.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_add_1',
          name: 'add_plan_item',
          input: {
            kind: 'content_post',
            userAction: 'approve',
            phase: 'audience',
            channel: 'x',
            scheduledAt: `${baseWeek}0T14:00:00.000Z`,
            skillName: null,
            params: {
              angle: 'data',
              anchor_theme: 'Indie devs waste hours on PR review',
            },
            title: 'Data post: the 6-hour PR-review tax',
            description: 'Monday anchor.',
          },
        },
        {
          type: 'tool_use',
          id: 'toolu_add_2',
          name: 'add_plan_item',
          input: {
            kind: 'content_post',
            userAction: 'approve',
            phase: 'audience',
            channel: 'x',
            scheduledAt: `${baseWeek}1T17:00:00.000Z`,
            skillName: null,
            params: {
              angle: 'contrarian',
              anchor_theme: 'Indie devs waste hours on PR review',
            },
            title: 'Contrarian post: the category assumption',
            description: 'Tuesday jolt.',
          },
        },
        {
          type: 'tool_use',
          id: 'toolu_add_3',
          name: 'add_plan_item',
          input: {
            kind: 'content_post',
            userAction: 'approve',
            phase: 'audience',
            channel: 'x',
            scheduledAt: `${baseWeek}2T14:00:00.000Z`,
            skillName: null,
            params: {
              angle: 'howto',
              anchor_theme: 'Indie devs waste hours on PR review',
            },
            title: 'Howto post: workflow in 5 steps',
            description: 'Wednesday depth.',
          },
        },
        {
          type: 'tool_use',
          id: 'toolu_add_4',
          name: 'add_plan_item',
          input: {
            kind: 'content_post',
            userAction: 'approve',
            phase: 'audience',
            channel: 'x',
            scheduledAt: `${baseWeek}4T17:00:00.000Z`,
            skillName: null,
            params: {
              angle: 'data',
              anchor_theme: 'Indie devs waste hours on PR review',
            },
            title: 'Data post: what shipping revealed',
            description: 'Friday close.',
          },
        },
        {
          type: 'tool_use',
          id: 'toolu_add_5',
          name: 'add_plan_item',
          input: {
            kind: 'setup_task',
            userAction: 'manual',
            phase: 'audience',
            channel: null,
            scheduledAt: `${baseWeek}0T09:00:00.000Z`,
            skillName: null,
            params: { targetCount: 5 },
            title: 'Run 5 discovery interviews',
            description: 'Manual follow-up.',
          },
        },
      ],
      stop_reason: 'tool_use',
    });

    // content-planner turn 2 — StructuredOutput.
    script.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_cp_so',
          name: 'StructuredOutput',
          input: {
            status: 'completed',
            weekStart: '2026-04-20T00:00:00.000Z',
            itemsAdded: 5,
            itemsByChannel: { x: 4, none: 1 },
            stalledCarriedOver: 0,
            notes: 'Week 1 planned: 4 X posts + 1 setup task.',
          },
        },
      ],
      stop_reason: 'tool_use',
    });

    // Coordinator turn 3 — terminal StructuredOutput.
    script.push({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_coord_so',
          name: 'StructuredOutput',
          input: {
            status: 'completed',
            summary:
              'Launch strategy designed: 3 pillars, 2-week arc, 5 items scheduled for week 1.',
            teamActivitySummary: [
              {
                memberType: 'growth-strategist',
                taskCount: 1,
                outputSummary: 'Strategic path written.',
              },
              {
                memberType: 'content-planner',
                taskCount: 1,
                outputSummary: '5 plan_items added.',
              },
            ],
            itemsProduced: {
              pathsWritten: 1,
              planItemsAdded: 5,
              draftsProduced: 0,
              messagesExchanged: 2,
            },
            errors: [],
          },
        },
      ],
      stop_reason: 'tool_use',
    });

    // --- Drive the processor ---
    const deps = {
      db: getStore().db,
      publish: async () => {
        /* sink */
      },
    };

    await processTeamRunInternal(runId, deps, () => {});

    // --- Assertions — Phase B Gate (spec §11) ---

    // 1) team_runs completed.
    const runRows = getStore().get<{ id: string; status: string }>(teamRuns);
    const run = runRows.find((r) => r.id === runId);
    expect(run).toBeDefined();
    expect(run!.status).toBe('completed');

    // 2) strategic_paths row written with non-null pillars.
    const pathRows = getStore().get<{
      userId: string;
      productId: string;
      contentPillars: unknown;
      narrative: string;
    }>(strategicPaths);
    const pathRow = pathRows.find(
      (p) => p.userId === userId && p.productId === productId,
    );
    expect(pathRow).toBeDefined();
    expect(Array.isArray(pathRow!.contentPillars)).toBe(true);
    expect((pathRow!.contentPillars as string[]).length).toBeGreaterThanOrEqual(
      3,
    );
    expect(pathRow!.narrative.length).toBeGreaterThan(100);

    // 3) plan_items ≥ 5 with non-null scheduledAt.
    const planRows = getStore().get<{
      userId: string;
      scheduledAt: unknown;
    }>(planItems);
    const userPlanItems = planRows.filter((p) => p.userId === userId);
    expect(userPlanItems.length).toBeGreaterThanOrEqual(5);
    for (const item of userPlanItems) {
      expect(item.scheduledAt).toBeDefined();
      expect(item.scheduledAt).not.toBeNull();
    }

    // 4) team_messages contain expected tool_calls.
    const messageRows = getStore().get<{
      type: string;
      metadata: { toolName?: string } | null;
    }>(teamMessages);
    const toolCalls = messageRows.filter((m) => m.type === 'tool_call');
    const toolNames = toolCalls
      .map((m) => (m.metadata as Record<string, unknown> | null)?.toolName)
      .filter((n): n is string => typeof n === 'string');
    const taskCalls = toolNames.filter((n) => n === 'Task');
    const structuredOutputCalls = toolNames.filter(
      (n) => n === 'StructuredOutput',
    );
    expect(taskCalls.length).toBe(2); // coordinator → gs, coordinator → cp
    expect(structuredOutputCalls.length).toBe(3); // gs, cp, coordinator

    // 5) team_tasks — one row per Task spawn.
    const taskRows = getStore().get<{ runId: string; status: string }>(teamTasks);
    const runTasks = taskRows.filter((t) => t.runId === runId);
    expect(runTasks.length).toBe(2);
    for (const t of runTasks) {
      expect(t.status).toBe('completed');
    }
  });
});
