/**
 * Dogfood: exercise the strategic-planner skill on a hardcoded product
 * fixture so you can eyeball whether the narrative reads like real
 * strategy or LLM fluff.
 *
 * Run:
 *   bun run scripts/test-strategic.ts              # default fixture
 *   bun run scripts/test-strategic.ts dev_tool     # specific category
 *
 * Requires ANTHROPIC_API_KEY in env. Does not touch the DB.
 *
 * Cost: ONE Sonnet 4.6 call per run. Roughly $0.03-0.08 depending on
 * output length. Budget: don't auto-run in CI.
 */
import { join } from 'node:path';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { strategicPathSchema } from '@/agents/schemas';

const strategicPlannerSkill = loadSkill(
  join(process.cwd(), 'src/skills/strategic-planner'),
);

type Category =
  | 'dev_tool'
  | 'saas'
  | 'consumer'
  | 'creator_tool'
  | 'agency'
  | 'ai_app'
  | 'other';

const fixtures: Record<string, Record<string, unknown>> = {
  dev_tool: {
    product: {
      name: 'ShipFlare',
      description:
        'Marketing autopilot for solo devs. Drafts a week of posts, replies, and emails in 20 minutes of approvals — in your voice, not a GPT voice.',
      valueProp:
        'Ship marketing without thinking about marketing. Indie devs who ship weekly keep shipping; marketing becomes a 20-min approval queue.',
      keywords: ['indiedev', 'buildinpublic', 'marketing-autopilot', 'solo-founder'],
      category: 'dev_tool' as Category,
      targetAudience:
        'Solo founders shipping one product every 1-4 weeks, technical, hate manual marketing busywork.',
    },
    state: 'launching' as const,
    currentPhase: 'audience' as const,
    launchDate: '2026-05-14T00:00:00Z',
    launchedAt: null,
    channels: ['x', 'reddit', 'email'] as const,
    voiceProfile: null,
    recentMilestones: [
      {
        title: 'Reply-guy engine: 15-min reply window for target accounts',
        summary:
          'Monitor surface picks tweets from a user\'s target list and fires reply drafts inside the 15-minute algorithmic window.',
        source: 'pr',
        atISO: '2026-04-16T21:30:00Z',
      },
      {
        title: 'Onboarding v2 chrome',
        summary:
          'Redesigned onboarding chrome (7 stages, v3 brand tokens) shipped to staging.',
        source: 'pr',
        atISO: '2026-04-18T14:15:00Z',
      },
    ],
  },
  consumer: {
    product: {
      name: 'MorningLoop',
      description:
        'A gentle 5-minute morning ritual app. Three prompts, one win. Replaces the 8-app routine most founders stitch together.',
      valueProp: 'One ritual, five minutes, one small win every morning.',
      keywords: ['rituals', 'morning', 'habits'],
      category: 'consumer' as Category,
      targetAudience:
        'Founders who have tried 4 productivity apps and abandoned them all.',
    },
    state: 'mvp' as const,
    currentPhase: 'foundation' as const,
    launchDate: null,
    launchedAt: null,
    channels: ['x', 'email'] as const,
    voiceProfile: null,
    recentMilestones: [],
  },
  ai_app: {
    product: {
      name: 'PromptKit',
      description:
        'An evals-first prompt library for teams building AI features. Every prompt has a failing test before the green test.',
      valueProp:
        'Prompts with guarantees. Every prompt in the library ships with failing eval cases so you know what will break.',
      keywords: ['evals', 'prompt-engineering', 'ai-infra'],
      category: 'ai_app' as Category,
      targetAudience:
        'Engineering teams shipping LLM features into production, tired of prompts that silently regress.',
    },
    state: 'launched' as const,
    currentPhase: 'compound' as const,
    launchDate: '2026-04-08T00:00:00Z',
    launchedAt: '2026-04-08T15:00:00Z',
    channels: ['x', 'reddit'] as const,
    voiceProfile: null,
    recentMilestones: [
      {
        title: 'v1.0 public release',
        summary: 'Open-source core released under Apache 2.0.',
        source: 'release',
        atISO: '2026-04-08T15:00:00Z',
      },
    ],
  },
};

async function main() {
  const categoryArg = (process.argv[2] ?? 'dev_tool') as keyof typeof fixtures;
  const fixture = fixtures[categoryArg];
  if (!fixture) {
    console.error(
      `Unknown fixture "${categoryArg}". Available: ${Object.keys(fixtures).join(', ')}`,
    );
    process.exit(1);
  }

  console.log(
    `\nRunning strategic-planner against the "${categoryArg}" fixture.\n`,
  );
  console.log('Input product:', (fixture.product as { name: string }).name);
  console.log(`Phase: ${fixture.currentPhase}   State: ${fixture.state}\n`);

  const result = await runSkill({
    skill: strategicPlannerSkill,
    input: fixture,
    outputSchema: strategicPathSchema,
  });

  if (result.errors.length > 0) {
    console.error('\nErrors:');
    for (const e of result.errors) {
      console.error(`- ${e.label}: ${e.error}`);
    }
    process.exit(1);
  }

  const path = result.results[0];
  if (!path) {
    console.error('No result returned from strategic-planner.');
    process.exit(1);
  }

  console.log('=== NARRATIVE ===');
  console.log(path.narrative);
  console.log('\n=== CONTENT PILLARS ===');
  for (const pillar of path.contentPillars) console.log('-', pillar);
  console.log('\n=== THESIS ARC ===');
  for (const week of path.thesisArc) {
    console.log(
      `${week.weekStart.slice(0, 10)}: ${week.theme}   [${week.angleMix.join(', ')}]`,
    );
  }
  console.log('\n=== MILESTONES ===');
  for (const m of path.milestones) {
    const sign = m.atDayOffset >= 0 ? '+' : '';
    console.log(
      `T${sign}${m.atDayOffset}d  (${m.phase})  ${m.title}  — metric: ${m.successMetric}`,
    );
  }
  console.log('\n=== CHANNEL MIX ===');
  console.log(JSON.stringify(path.channelMix, null, 2));
  console.log('\n=== PHASE GOALS ===');
  for (const [phase, goal] of Object.entries(path.phaseGoals)) {
    if (goal) console.log(`${phase}: ${goal}`);
  }

  const { usage } = result;
  console.log('\n=== USAGE ===');
  console.log(`input tokens: ${usage.inputTokens}`);
  console.log(`output tokens: ${usage.outputTokens}`);
  console.log(`cost usd: $${usage.costUsd.toFixed(4)}`);

  console.log(
    '\n✅ Schema-valid. Eyeball the narrative + thesis for LLM fluff.\n',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
