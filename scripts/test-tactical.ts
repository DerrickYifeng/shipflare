/**
 * Dogfood: exercise the tactical-planner skill on a hardcoded strategic
 * path + week signals so you can eyeball whether the item list reads
 * specific-to-this-product or generic-marketing-plan.
 *
 * Run:
 *   bun run scripts/test-tactical.ts           # foundation-phase fixture
 *   bun run scripts/test-tactical.ts audience  # audience-phase fixture
 *   bun run scripts/test-tactical.ts compound  # compound-phase fixture
 *
 * Requires ANTHROPIC_API_KEY in env. Does not touch the DB.
 *
 * Cost: ONE Haiku 4.5 call per run. Roughly $0.002-0.005. Cheap enough
 * to run freely, but still not something to auto-run in CI.
 */
import { join } from 'node:path';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { tacticalPlanSchema, type StrategicPath } from '@/agents/schemas';
import { SKILL_CATALOG } from '@/skills/_catalog';

const tacticalPlannerSkill = loadSkill(
  join(process.cwd(), 'src/skills/tactical-planner'),
);

const productContext = {
  name: 'ShipFlare',
  valueProp:
    'Ship marketing without thinking about marketing. Indie devs who ship weekly keep shipping; marketing becomes a 20-min approval queue.',
};

const strategicPath: StrategicPath = {
  narrative:
    'ShipFlare\'s audience-phase arc argues one thesis: marketing is an approval queue, not a second job. Weekly cadence is lean on purpose — four X posts, one Reddit thread, one email. The biggest risk is overposting in the run-up to launch; we hedge with data-angle posts that pay off the shipped reply-guy engine.',
  thesisArc: [
    {
      weekStart: '2026-04-20T00:00:00Z',
      theme: 'Marketing is an approval queue, not a second job',
      angleMix: ['claim', 'story', 'contrarian'],
    },
    {
      weekStart: '2026-04-27T00:00:00Z',
      theme: 'What the reply-guy engine is about to cost every solo founder',
      angleMix: ['data', 'howto'],
    },
  ],
  contentPillars: ['build-in-public', 'solo-dev-ops', 'tooling-counterfactuals'],
  channelMix: {
    x: { perWeek: 4, preferredHours: [14, 17, 21] },
    reddit: {
      perWeek: 1,
      preferredHours: [15],
      preferredCommunities: ['r/SideProject', 'r/indiehackers'],
    },
    email: { perWeek: 1, preferredHours: [13] },
  },
  phaseGoals: {
    foundation: 'Nail positioning + 100 waitlist',
    audience: 'Hit 500 followers + 50 beta users',
    momentum: '10 hunter commits, runsheet locked',
    launch: 'Top 5 of the day + 300 first-hour signups',
  },
  milestones: [
    {
      atDayOffset: -28,
      title: 'Hit 100 waitlist signups',
      successMetric: 'waitlist count >= 100',
      phase: 'foundation',
    },
    {
      atDayOffset: -14,
      title: 'Ship reply-guy engine',
      successMetric: 'reply window is 15min for 10 target accounts',
      phase: 'audience',
    },
    {
      atDayOffset: -7,
      title: 'Confirm 5 hunters',
      successMetric: 'five hunters committed in writing',
      phase: 'momentum',
    },
  ],
};

type PhaseArg = 'foundation' | 'audience' | 'compound';

function makeFixture(phase: PhaseArg) {
  const weekStart = '2026-04-20T00:00:00Z';
  const weekEnd = '2026-04-26T23:59:59Z';

  const phaseToFixture: Record<PhaseArg, Record<string, unknown>> = {
    foundation: {
      currentPhase: 'foundation',
      state: 'mvp',
      launchDate: null,
      launchedAt: null,
      signals: {
        recentMilestones: [],
        recentMetrics: [],
        stalledItems: [],
        completedLastWeek: [],
        currentLaunchTasks: [],
      },
    },
    audience: {
      currentPhase: 'audience',
      state: 'launching',
      launchDate: '2026-05-14T00:00:00Z',
      launchedAt: null,
      signals: {
        recentMilestones: [
          {
            title: 'Reply-guy engine shipped',
            summary: '15-min reply window for target accounts.',
            source: 'pr',
            atISO: '2026-04-16T21:30:00Z',
          },
        ],
        recentMetrics: [
          { kind: 'impressions', value: 11400, delta: 0.18 },
          { kind: 'followers_delta', value: 42, delta: 0.4 },
        ],
        stalledItems: [
          { title: 'Draft the voice-extractor interview', kind: 'setup_task' },
        ],
        completedLastWeek: [
          { title: 'Baseline metrics for week 1', kind: 'analytics_summary' },
        ],
        currentLaunchTasks: [],
      },
    },
    compound: {
      currentPhase: 'compound',
      state: 'launched',
      launchDate: '2026-04-08T00:00:00Z',
      launchedAt: '2026-04-08T15:00:00Z',
      signals: {
        recentMilestones: [],
        recentMetrics: [
          { kind: 'week_2_retention', value: 0.58 },
          { kind: 'top_post_impressions', value: 42000 },
        ],
        stalledItems: [],
        completedLastWeek: [
          { title: 'Day-3 launch retrospective', kind: 'content_post' },
          { title: 'Pinned maker comment', kind: 'launch_asset' },
        ],
        currentLaunchTasks: [
          { title: 'Identify top 10 supporters for launch thanks', kind: 'analytics_summary' },
        ],
      },
    },
  };

  return {
    strategicPath,
    product: {
      ...productContext,
      ...phaseToFixture[phase],
    },
    channels: ['x', 'reddit', 'email'] as const,
    weekStart,
    weekEnd,
    signals: phaseToFixture[phase].signals,
    skillCatalog: SKILL_CATALOG.map((s) => ({
      name: s.name,
      description: s.description,
      supportedKinds: s.supportedKinds,
      channels: s.channels,
    })),
    voiceBlock: null,
  };
}

async function main() {
  const phaseArg = (process.argv[2] ?? 'audience') as PhaseArg;
  if (!['foundation', 'audience', 'compound'].includes(phaseArg)) {
    console.error(
      `Unknown phase "${phaseArg}". Available: foundation | audience | compound`,
    );
    process.exit(1);
  }

  const input = makeFixture(phaseArg);
  console.log(`\nRunning tactical-planner for ${phaseArg}-phase fixture.\n`);
  console.log('Week:', input.weekStart.slice(0, 10), '→', input.weekEnd.slice(0, 10));
  console.log('Channels:', input.channels.join(', '), '\n');

  const result = await runSkill({
    skill: tacticalPlannerSkill,
    input,
    outputSchema: tacticalPlanSchema,
  });

  if (result.errors.length > 0) {
    console.error('\nErrors:');
    for (const e of result.errors) {
      console.error(`- ${e.label}: ${e.error}`);
    }
    process.exit(1);
  }

  const plan = result.results[0];
  if (!plan) {
    console.error('No result returned from tactical-planner.');
    process.exit(1);
  }

  console.log('=== PLAN ===');
  console.log('Thesis:', plan.plan.thesis);
  console.log('\nFounder notes:');
  console.log(plan.plan.notes);

  console.log(`\n=== ITEMS (${plan.items.length}) ===`);
  for (const item of plan.items) {
    console.log(
      `\n  [${item.kind}]  ${item.title}`,
    );
    console.log(
      `      scheduledAt: ${item.scheduledAt}   channel: ${item.channel ?? '—'}   userAction: ${item.userAction}   skill: ${item.skillName ?? '—'}`,
    );
    if (item.description) {
      console.log(`      ${item.description}`);
    }
    if (Object.keys(item.params).length > 0) {
      console.log(`      params: ${JSON.stringify(item.params)}`);
    }
  }

  // Contract checks the Phase 7 dispatcher will also enforce
  const kinds = plan.items.map((i) => i.kind);
  const channels = plan.items.map((i) => i.channel);
  const actions = plan.items.map((i) => i.userAction);

  console.log('\n=== CONTRACT CHECKS ===');
  console.log(
    `items with channel NOT in active channels:`,
    channels.filter((c) => c !== null && !['x', 'reddit', 'email'].includes(c)).length,
  );
  console.log(`content_posts with anchor_theme:`, plan.items.filter(
    (i) => i.kind === 'content_post' && typeof i.params.anchor_theme === 'string',
  ).length, '/', plan.items.filter((i) => i.kind === 'content_post').length);
  console.log(
    `content_* items with userAction !== 'approve':`,
    plan.items.filter(
      (i) =>
        (i.kind === 'content_post' || i.kind === 'content_reply') &&
        i.userAction !== 'approve',
    ).length,
  );
  console.log(
    `interview / setup_task items with userAction !== 'manual':`,
    plan.items.filter(
      (i) =>
        (i.kind === 'interview' || i.kind === 'setup_task') &&
        i.userAction !== 'manual',
    ).length,
  );

  void kinds; // silence unused
  void actions;

  const { usage } = result;
  console.log('\n=== USAGE ===');
  console.log(`input tokens: ${usage.inputTokens}`);
  console.log(`output tokens: ${usage.outputTokens}`);
  console.log(`cost usd: $${usage.costUsd.toFixed(4)}`);

  console.log(
    '\n✅ Schema-valid. Eyeball: are the items specific-to-ShipFlare or generic?\n',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
