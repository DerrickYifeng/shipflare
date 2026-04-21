// Phase C equivalence gate (Task #2, spec §14.4 + §11 Phase C Prerequisite).
//
// Runs the 20 onboarding fixtures through BOTH paths and asserts the four
// output metrics (pillar count, item count, channel distribution, schedule
// spread) agree within ±15%:
//
//   - v2 (legacy) = runSkill('strategic-planner') → runSkill('tactical-planner')
//     — the path /api/onboarding/plan + /api/onboarding/commit drive today.
//   - v3 (new)    = processTeamRunInternal with trigger='onboarding'
//     — the coordinator → growth-strategist → content-planner team.
//
// By default the test is a no-op so normal `pnpm vitest` passes without
// burning Anthropic credit. Enable it by setting RUN_EQUIVALENCE_EVAL=1
// AND providing an ANTHROPIC_API_KEY:
//
//   RUN_EQUIVALENCE_EVAL=1 pnpm vitest run \
//     src/lib/__tests__/onboarding-equivalence.eval.test.ts
//
// The test drives the production AGENT.md + SKILL.md files through real
// Anthropic calls. Expected cost: ~$2 per full run (20 fixtures × 2 paths
// × ~$0.05/call). 20 fixtures run sequentially to avoid rate-limit bursts.
//
// Stability protocol (spec §11 Phase C Prerequisite): run the test twice
// in staging with >24h between runs before Phase C Day 1 deletions start;
// record the timestamps of two consecutive passes + drift summary in the
// task comment. If any fixture exceeds ±15% drift, stop and DM product-
// lead — divergence investigation is a product-lead decision, not an
// inline fix. See team-lead's Phase C kickoff note.
import { describe, it, beforeEach, afterEach, vi, expect } from 'vitest';
import * as path from 'node:path';
import {
  createInMemoryStore,
  drizzleMockFactory,
} from '@/lib/test-utils/in-memory-db';
import { EQUIVALENCE_FIXTURES, FIXTURE_NOW_ISO } from './fixtures/onboarding-equivalence';
import type { EquivalenceFixture } from './fixtures/onboarding-equivalence';
import {
  countByChannel,
  analyzeDateSpread,
  withinTolerance,
  compareChannelDistribution,
  compareScheduleSpread,
  type EquivalencePlanItem,
  type ToleranceResult,
} from './equivalence-helpers';

// ---------------------------------------------------------------------------
// Gate — the eval only runs when the operator explicitly opts in by setting
// RUN_EQUIVALENCE_EVAL=1. In that case ANTHROPIC_API_KEY is mandatory; if
// it's missing we throw loudly rather than silently skip — the operator
// is trying to run the eval and deserves to know why it won't produce
// numbers.
// ---------------------------------------------------------------------------

const EVAL_OPT_IN = process.env.RUN_EQUIVALENCE_EVAL === '1';

if (EVAL_OPT_IN && !process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    'RUN_EQUIVALENCE_EVAL=1 but ANTHROPIC_API_KEY is unset. The eval test issues real ' +
      'Anthropic calls (~$2 per run) and cannot run without credentials. Either set ' +
      'ANTHROPIC_API_KEY or unset RUN_EQUIVALENCE_EVAL.',
  );
}

const MAYBE_DESCRIBE = EVAL_OPT_IN ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Module mocks — mirror `onboarding-team-run.integration.test.ts` but
// leave `@/core/api-client` un-mocked so real Anthropic calls flow through.
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
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    traceId: 'test-trace',
  }),
}));

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return drizzleMockFactory(actual);
});

let storeRef: ReturnType<typeof createInMemoryStore> | null = null;
function getStore(): ReturnType<typeof createInMemoryStore> {
  if (storeRef === null) storeRef = createInMemoryStore();
  return storeRef;
}

vi.mock('@/lib/db', () => ({
  get db() {
    return getStore().db;
  },
}));

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
  getKeyValueClient: () => ({
    get: async () => null,
    set: async () => 'OK',
    incrbyfloat: async () => '0',
    expire: async () => 1,
  }),
  publishUserEvent: async () => {},
}));

// Stub cost-bucket so runSkill doesn't try to talk to Redis for runId-less
// skill runs.
vi.mock('@/lib/cost-bucket', () => ({
  addCost: async () => {},
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import {
  teams,
  teamMembers,
  teamRuns,
  teamMessages,
  products,
  plans,
  strategicPaths,
  planItems,
} from '@/lib/db/schema';
import '@/tools/registry';
import '@/tools/registry-team';
import { processTeamRunInternal } from '@/workers/processors/team-run';
import {
  __resetAgentRegistry,
  __setAgentsRootForTesting,
} from '@/tools/AgentTool/registry';
import { runSkill } from '@/core/skill-runner';
import { loadSkill } from '@/core/skill-loader';
import {
  strategicPathSchema,
  tacticalPlanSchema,
  type StrategicPath,
  type TacticalPlan,
} from '@/agents/schemas';
import { SKILL_CATALOG } from '@/skills/_catalog';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const PRODUCTION_AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);
const V2_STRATEGIC_SKILL_DIR = path.resolve(
  process.cwd(),
  'src/skills/strategic-planner',
);
const V2_TACTICAL_SKILL_DIR = path.resolve(
  process.cwd(),
  'src/skills/tactical-planner',
);

const FIXTURE_NOW = new Date(FIXTURE_NOW_ISO);
const WEEK_START = new Date(FIXTURE_NOW_ISO); // Fixture NOW is midnight UTC.
const WEEK_END = new Date(FIXTURE_NOW.getTime() + 7 * 86_400_000);

// Catalog projection — matches src/lib/re-plan.ts shape.
const CATALOG_PROJECTION = SKILL_CATALOG.map((s) => ({
  name: s.name,
  description: s.description,
  supportedKinds: [...s.supportedKinds],
  ...(s.channels ? { channels: [...s.channels] } : {}),
}));

// ---------------------------------------------------------------------------
// v2 runner — invokes the legacy strategic + tactical planner chain.
// ---------------------------------------------------------------------------

interface V2Outcome {
  path: StrategicPath;
  plan: TacticalPlan;
}

async function runV2(fixture: EquivalenceFixture): Promise<V2Outcome> {
  const strategicSkill = loadSkill(V2_STRATEGIC_SKILL_DIR);
  const tacticalSkill = loadSkill(V2_TACTICAL_SKILL_DIR);

  const strategicInput = {
    product: {
      name: fixture.productName,
      description: fixture.productDescription,
      valueProp: fixture.valueProp,
      keywords: fixture.keywords,
      category: fixture.category,
      targetAudience: fixture.targetAudience,
    },
    state: fixture.state,
    currentPhase: fixture.launchPhase,
    launchDate: fixture.launchDate,
    launchedAt: fixture.launchedAt,
    channels: fixture.channels,
    voiceProfile: fixture.voiceProfile,
    recentMilestones: fixture.recentMilestones,
  };

  const strategicRes = await runSkill<StrategicPath>({
    skill: strategicSkill,
    input: strategicInput,
    outputSchema: strategicPathSchema,
  });
  if (strategicRes.errors.length > 0 || !strategicRes.results[0]) {
    throw new Error(
      `v2 strategic-planner failed: ${strategicRes.errors.map((e) => e.error).join('; ')}`,
    );
  }
  const strategicPath = strategicRes.results[0];

  const tacticalInput = {
    strategicPath: {
      narrative: strategicPath.narrative,
      thesisArc: strategicPath.thesisArc,
      contentPillars: strategicPath.contentPillars,
      channelMix: strategicPath.channelMix,
      phaseGoals: strategicPath.phaseGoals,
      milestones: strategicPath.milestones,
    },
    product: {
      name: fixture.productName,
      valueProp: fixture.valueProp,
      currentPhase: fixture.launchPhase,
      state: fixture.state,
      launchDate: fixture.launchDate,
      launchedAt: fixture.launchedAt,
    },
    channels: fixture.channels,
    weekStart: WEEK_START.toISOString(),
    weekEnd: WEEK_END.toISOString(),
    signals: {
      recentMilestones: fixture.recentMilestones.map((m) => ({
        title: m.title,
        summary: m.summary,
        source: m.source,
        atISO: m.atISO,
      })),
      recentMetrics: [],
      stalledItems: [],
      completedLastWeek: [],
      currentLaunchTasks: [],
    },
    skillCatalog: CATALOG_PROJECTION,
    voiceBlock: null,
  };

  const tacticalRes = await runSkill<TacticalPlan>({
    skill: tacticalSkill,
    input: tacticalInput,
    outputSchema: tacticalPlanSchema,
  });
  if (tacticalRes.errors.length > 0 || !tacticalRes.results[0]) {
    throw new Error(
      `v2 tactical-planner failed: ${tacticalRes.errors.map((e) => e.error).join('; ')}`,
    );
  }

  return { path: strategicPath, plan: tacticalRes.results[0] };
}

// ---------------------------------------------------------------------------
// v3 runner — seeds in-memory DB + drives processTeamRunInternal.
// ---------------------------------------------------------------------------

interface V3Outcome {
  /** StrategicPath extracted from the write_strategic_path tool_call. */
  path: StrategicPath;
  /** plan_items captured from add_plan_item tool_calls. */
  planItems: EquivalencePlanItem[];
  /** Total team_messages published (all types). Debug signal for retries. */
  messageCount: number;
  /**
   * Count of StructuredOutput correction tool_results (indicator of agent
   * retry loops). Hitting MAX_STRUCTURED_OUTPUT_RETRIES = 5 suggests the
   * agent prompt or schema has an issue.
   */
  structuredOutputRetries: number;
}

async function runV3(fixture: EquivalenceFixture): Promise<V3Outcome> {
  const store = getStore();
  const userId = `u-${fixture.fixtureId}`;
  const productId = `p-${fixture.fixtureId}`;
  const teamId = `t-${fixture.fixtureId}`;
  const coordId = `mem-coord-${fixture.fixtureId}`;
  const gsId = `mem-gs-${fixture.fixtureId}`;
  const cpId = `mem-cp-${fixture.fixtureId}`;
  const runId = `run-${fixture.fixtureId}`;
  const planId = `plan-${fixture.fixtureId}`;

  store.get(products).push({
    id: productId,
    userId,
    name: fixture.productName,
    description: fixture.productDescription,
    category: fixture.category,
    state: fixture.state,
    launchDate: fixture.launchDate ? new Date(fixture.launchDate) : null,
    launchedAt: fixture.launchedAt ? new Date(fixture.launchedAt) : null,
    keywords: fixture.keywords,
    valueProp: fixture.valueProp,
    url: null,
    targetAudience: fixture.targetAudience,
  });

  store.get(plans).push({
    id: planId,
    userId,
    productId,
    strategicPathId: null,
    trigger: 'onboarding',
    weekStart: WEEK_START,
    generatedAt: FIXTURE_NOW,
    notes: null,
    usageSummary: null,
  });

  store.get(teams).push({
    id: teamId,
    userId,
    productId,
    name: 'Equivalence Test Team',
    config: {},
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
  });

  store.get(teamMembers).push(
    {
      id: coordId,
      teamId,
      agentType: 'coordinator',
      displayName: 'Sam',
      status: 'idle',
      lastActiveAt: null,
      createdAt: FIXTURE_NOW,
    },
    {
      id: gsId,
      teamId,
      agentType: 'growth-strategist',
      displayName: 'Alex',
      status: 'idle',
      lastActiveAt: null,
      createdAt: FIXTURE_NOW,
    },
    {
      id: cpId,
      teamId,
      agentType: 'content-planner',
      displayName: 'Maya',
      status: 'idle',
      lastActiveAt: null,
      createdAt: FIXTURE_NOW,
    },
  );

  const goal =
    `Plan the launch strategy for ${fixture.productName}. ` +
    `State: ${fixture.state}. Phase: ${fixture.launchPhase}. ` +
    `Category: ${fixture.category}. ` +
    `Channels: ${fixture.channels.join(', ')}. ` +
    (fixture.recentMilestones.length > 0
      ? `Recent milestones: ${fixture.recentMilestones
          .map((m) => m.title)
          .join('; ')}.`
      : 'No recent milestones.');

  store.get(teamRuns).push({
    id: runId,
    teamId,
    trigger: 'onboarding',
    goal,
    rootAgentId: coordId,
    status: 'pending',
    startedAt: FIXTURE_NOW,
    completedAt: null,
    totalCostUsd: null,
    totalTurns: 0,
    traceId: `trace-${fixture.fixtureId}`,
    errorMessage: null,
  });

  // Seed the (products, teams, team_members, teamRuns) rows — done.
  // Now run the processor. Track published team_messages so we can pull
  // write_strategic_path + add_plan_item inputs back out.
  const captured: Array<Record<string, unknown>> = [];

  await processTeamRunInternal(
    runId,
    {
      db: store.db,
      publish: async (_channel, payload) => {
        captured.push(payload);
      },
    },
    // Silent log line
    () => {},
  );

  // Extract strategic path from write_strategic_path tool_call.
  const writePathCall = captured.find(
    (m) =>
      m.type === 'tool_call' &&
      (m.metadata as Record<string, unknown> | null)?.toolName ===
        'write_strategic_path',
  );
  if (!writePathCall) {
    throw new Error('v3 run produced no write_strategic_path tool_call');
  }
  const writePathInput = (writePathCall.metadata as Record<string, unknown>)
    .input;
  const path = strategicPathSchema.parse(writePathInput);

  // Extract plan items from add_plan_item tool_calls.
  const addItemCalls = captured.filter(
    (m) =>
      m.type === 'tool_call' &&
      (m.metadata as Record<string, unknown> | null)?.toolName ===
        'add_plan_item',
  );
  const items: EquivalencePlanItem[] = addItemCalls.map((call) => {
    const input = (call.metadata as Record<string, unknown>).input as Record<
      string,
      unknown
    >;
    return {
      kind: String(input.kind ?? 'unknown'),
      channel: (input.channel as string | null | undefined) ?? null,
      scheduledAtISO: String(input.scheduledAt ?? ''),
    };
  });

  // Count StructuredOutput-correction tool_results — a retry indicator.
  // The `StructuredOutputTool` emits a tool_result with isError=true when
  // the agent's payload fails Zod validation; we count those to spot
  // tight retry loops.
  const structuredOutputRetries = captured.filter(
    (m) =>
      m.type === 'tool_result' &&
      (m.metadata as Record<string, unknown> | null)?.toolName ===
        'StructuredOutput' &&
      (m.metadata as Record<string, unknown>).isError === true,
  ).length;

  return {
    path,
    planItems: items,
    messageCount: captured.length,
    structuredOutputRetries,
  };
}

// ---------------------------------------------------------------------------
// Fixture hooks
// ---------------------------------------------------------------------------

beforeEach(() => {
  getStore().tables.clear();
  __setAgentsRootForTesting(PRODUCTION_AGENTS_ROOT);
});

afterEach(() => {
  __resetAgentRegistry();
});

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

MAYBE_DESCRIBE('Phase C equivalence gate: onboarding v2 vs v3 parity', () => {
  // Log once at the start so operators can eyeball the expected spend.
  const fixtureCount = EQUIVALENCE_FIXTURES.length;
  // eslint-disable-next-line no-console
  console.log(
    `[equivalence-eval] Running ${fixtureCount} fixtures × 2 paths ≈ $${(fixtureCount * 0.1).toFixed(2)} total. ` +
      `Set RUN_EQUIVALENCE_EVAL=0 to skip.`,
  );

  // Track pass/fail per fixture so the final summary line is useful.
  const summary: Array<{
    fixtureId: string;
    pass: boolean;
    details: ToleranceResult[];
  }> = [];

  for (const fixture of EQUIVALENCE_FIXTURES) {
    it(
      `${fixture.fixtureId} — v2 and v3 agree within ±15%`,
      // 5 min per fixture — v3 team-run with 3 AGENT.md's + Task fan-out
      // hits 2-3 Sonnet calls + several Haiku calls; 180s was too tight
      // (observed 180010ms timeout on dev_tool-foundation on 2026-04-21).
      { timeout: 300_000 },
      async () => {
        const t0 = Date.now();
        const v2Promise = (async () => {
          const start = Date.now();
          const result = await runV2(fixture);
          const durMs = Date.now() - start;
          // eslint-disable-next-line no-console
          console.log(
            `[equivalence-eval] ${fixture.fixtureId} v2 done in ${(durMs / 1000).toFixed(1)}s ` +
              `pillars=${result.path.contentPillars.length} items=${result.plan.items.length}`,
          );
          return result;
        })();
        const v3Promise = (async () => {
          const start = Date.now();
          const result = await runV3(fixture);
          const durMs = Date.now() - start;
          // eslint-disable-next-line no-console
          console.log(
            `[equivalence-eval] ${fixture.fixtureId} v3 done in ${(durMs / 1000).toFixed(1)}s ` +
              `pillars=${result.path.contentPillars.length} items=${result.planItems.length} ` +
              `msgs=${result.messageCount} strOutRetries=${result.structuredOutputRetries}`,
          );
          return result;
        })();
        const [v2, v3] = await Promise.all([v2Promise, v3Promise]);
        const totalMs = Date.now() - t0;
        // eslint-disable-next-line no-console
        console.log(
          `[equivalence-eval] ${fixture.fixtureId} fixture wall-clock ${(totalMs / 1000).toFixed(1)}s`,
        );

        const v2Items: EquivalencePlanItem[] = v2.plan.items.map((i) => ({
          kind: i.kind,
          channel: i.channel ?? null,
          scheduledAtISO: i.scheduledAt,
        }));

        const v2Channel = countByChannel(v2Items);
        const v3Channel = countByChannel(v3.planItems);
        const v2Spread = analyzeDateSpread(v2Items);
        const v3Spread = analyzeDateSpread(v3.planItems);

        const results: ToleranceResult[] = [
          withinTolerance(
            v3.path.contentPillars.length,
            v2.path.contentPillars.length,
            0.15,
            'contentPillars.length',
          ),
          withinTolerance(
            v3.planItems.length,
            v2.plan.items.length,
            0.15,
            'planItems.length',
          ),
          ...compareChannelDistribution(v3Channel, v2Channel, 0.15),
          ...compareScheduleSpread(v3Spread, v2Spread, 0.15),
        ];

        const pass = results.every((r) => r.pass);
        summary.push({ fixtureId: fixture.fixtureId, pass, details: results });

        // eslint-disable-next-line no-console
        console.log(
          `[equivalence-eval] ${fixture.fixtureId}: ${pass ? 'PASS' : 'FAIL'}`,
        );
        for (const r of results) {
          // eslint-disable-next-line no-console
          console.log(`  ${r.pass ? '✓' : '✗'} ${r.detail}`);
        }

        const failures = results.filter((r) => !r.pass);
        expect(failures, `drift exceeds 15%: ${failures.map((f) => f.detail).join(' | ')}`).toHaveLength(0);
      },
    );
  }

  it('[summary] 20 fixtures all within ±15%', () => {
    const failed = summary.filter((s) => !s.pass);
    // eslint-disable-next-line no-console
    console.log(
      `[equivalence-eval] Summary: ${summary.length - failed.length}/${summary.length} PASS`,
    );
    if (failed.length > 0) {
      for (const f of failed) {
        // eslint-disable-next-line no-console
        console.log(`  FAIL ${f.fixtureId}: ${f.details.filter((d) => !d.pass).map((d) => d.detail).join(' | ')}`);
      }
    }
    expect(failed).toHaveLength(0);
  });
});
