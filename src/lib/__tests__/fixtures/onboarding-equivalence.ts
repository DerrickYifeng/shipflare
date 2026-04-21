// Fixtures for the Phase C equivalence gate test (Task #2, spec §14.4).
//
// 5 product categories × 4 state/phase combinations = 20 fixtures. Each
// fixture exercises one real (state, launch-phase) slice of the user space
// so the equivalence test covers brainstorm / pre-launch / launch-week /
// post-launch behavior uniformly across categories.
//
// State → phase mapping (derived by `src/lib/launch-phase.ts::derivePhase`):
//   - ('mvp', no launchDate)                   → 'foundation'
//   - ('launching', launchDate ~14d out)       → 'audience'
//   - ('launching', launchDate today)          → 'launch'
//   - ('launched', launchedAt 14d ago)         → 'compound'
//
// We pin fixture dates relative to a NOW constant so derivePhase computes
// the expected phase deterministically when the test runs.

import type { LaunchPhase } from '@/lib/launch-phase';

export type ProductState = 'mvp' | 'launching' | 'launched';

export type ProductCategory =
  | 'dev_tool'
  | 'saas'
  | 'ai_app'
  | 'consumer'
  | 'creator_tool';

export type ChannelId = 'x' | 'reddit' | 'email';

export interface RecentMilestone {
  title: string;
  summary: string;
  source: 'commit' | 'pr' | 'release';
  atISO: string;
}

export interface EquivalenceFixture {
  /** Human-readable fixture id, e.g. 'dev_tool-foundation'. */
  fixtureId: string;
  /** Product display name. */
  productName: string;
  productDescription: string;
  valueProp: string;
  keywords: string[];
  targetAudience: string;
  category: ProductCategory;
  state: ProductState;
  /** Expected launch phase derived from state + date. Assertion-only. */
  launchPhase: LaunchPhase;
  /** ISO or null, depending on state. */
  launchDate: string | null;
  launchedAt: string | null;
  channels: ChannelId[];
  voiceProfile: string | null;
  recentMilestones: RecentMilestone[];
}

/**
 * Pinned to a fixed NOW so derivePhase() returns deterministic values
 * independent of wall-clock when the eval runs. 2026-05-01T00:00:00Z was
 * picked to sit inside every fixture's phase window with a comfortable
 * buffer (7+ days from any boundary).
 */
export const FIXTURE_NOW_ISO = '2026-05-01T00:00:00.000Z';

/**
 * Relative-to-FIXTURE_NOW date helpers. Keeps fixtures readable without
 * hand-computing ISO strings.
 */
function addDays(isoAnchor: string, days: number): string {
  return new Date(new Date(isoAnchor).getTime() + days * 86_400_000).toISOString();
}

const LAUNCH_DATE_IN_14D = addDays(FIXTURE_NOW_ISO, 14);
const LAUNCH_DATE_TODAY = FIXTURE_NOW_ISO;
const LAUNCHED_AT_14D_AGO = addDays(FIXTURE_NOW_ISO, -14);

// ---------------------------------------------------------------------------
// Per-category copy. Kept short + intentionally on-character so agent
// outputs bear some variance between fixtures even on the same (state, phase)
// slice. Where sensible we mirror the prose from scripts/test-strategic.ts.
// ---------------------------------------------------------------------------

interface CategoryCopy {
  productName: string;
  description: string;
  valueProp: string;
  keywords: string[];
  targetAudience: string;
  channels: ChannelId[];
}

const COPY: Record<ProductCategory, CategoryCopy> = {
  dev_tool: {
    productName: 'ShipFlare',
    description:
      "Marketing autopilot for solo devs. Drafts a week of posts, replies, and emails in 20 minutes of approvals — in your voice, not a GPT voice.",
    valueProp:
      'Ship marketing without thinking about marketing. Indie devs who ship weekly keep shipping; marketing becomes a 20-min approval queue.',
    keywords: ['indiedev', 'buildinpublic', 'marketing-autopilot', 'solo-founder'],
    targetAudience:
      'Solo founders shipping one product every 1-4 weeks, technical, hate manual marketing busywork.',
    channels: ['x', 'reddit', 'email'],
  },
  saas: {
    productName: 'FlowSync',
    description:
      'Unified status pages for B2B SaaS. One source of truth for incidents, component health, and postmortems — customer-facing in 15 minutes.',
    valueProp:
      'Replace the three-tool incident stack (Statuspage + Pingdom + Notion) with one page customers actually trust.',
    keywords: ['status-pages', 'devops', 'incident-management', 'b2b-saas'],
    targetAudience:
      'B2B SaaS platform teams (50-500 eng) who currently patch together status pages manually.',
    channels: ['x', 'email'],
  },
  ai_app: {
    productName: 'PromptKit',
    description:
      'An evals-first prompt library for teams building AI features. Every prompt ships with a failing test before the green test.',
    valueProp:
      'Prompts with guarantees. Every prompt in the library ships with failing eval cases so you know what will break.',
    keywords: ['evals', 'prompt-engineering', 'ai-infra', 'llm-tooling'],
    targetAudience:
      'Engineering teams shipping LLM features into production, tired of prompts that silently regress.',
    channels: ['x', 'reddit'],
  },
  consumer: {
    productName: 'MorningLoop',
    description:
      'A gentle 5-minute morning ritual app. Three prompts, one win. Replaces the 8-app routine most founders stitch together.',
    valueProp: 'One ritual, five minutes, one small win every morning.',
    keywords: ['rituals', 'morning', 'habits', 'wellness'],
    targetAudience:
      'Founders who have tried 4 productivity apps and abandoned them all.',
    channels: ['x', 'email'],
  },
  creator_tool: {
    productName: 'ThreadKiln',
    description:
      'Long-form-to-thread compiler. Paste a blog post; get a 6-tweet thread with the sharpest 3 pulls surfaced first.',
    valueProp: "Turn your weekly writing into a weekly thread in two minutes, without losing your voice.",
    keywords: ['creator-tools', 'writing', 'twitter-threads', 'content-repurposing'],
    targetAudience:
      'Writers with a weekly newsletter who also want to show up on X but dread the rewrite.',
    channels: ['x', 'email'],
  },
};

// ---------------------------------------------------------------------------
// Recent-milestone seeds. Three shapes: empty, single commit, real release.
// The product-copy file chooses which to attach based on state.
// ---------------------------------------------------------------------------

const MILESTONES_EMPTY: RecentMilestone[] = [];

const MILESTONES_PREMILESTONE: RecentMilestone[] = [
  {
    title: 'Onboarding chrome v2',
    summary:
      'Redesigned onboarding chrome (7 stages, v3 brand tokens) shipped to staging.',
    source: 'pr',
    atISO: addDays(FIXTURE_NOW_ISO, -3),
  },
];

const MILESTONES_LAUNCH_WEEK: RecentMilestone[] = [
  {
    title: 'Reply-guy engine: 15-min reply window',
    summary:
      "Monitor surface picks tweets from a user's target list and fires reply drafts inside the 15-minute algorithmic window.",
    source: 'pr',
    atISO: addDays(FIXTURE_NOW_ISO, -5),
  },
  {
    title: 'Onboarding Stage 6 advance time dropped to 30s',
    summary:
      'Tactical-generate now runs post-commit in the background; Stage 6 no longer blocks on planner latency.',
    source: 'commit',
    atISO: addDays(FIXTURE_NOW_ISO, -1),
  },
];

const MILESTONES_POSTLAUNCH: RecentMilestone[] = [
  {
    title: 'v1.0 public release',
    summary:
      'Core released publicly. First 100 signups, HN front-page briefly.',
    source: 'release',
    atISO: LAUNCHED_AT_14D_AGO,
  },
  {
    title: 'Team feature on /today',
    summary:
      "Marketing team activity log shipped; founder can see what the AI team did each day.",
    source: 'pr',
    atISO: addDays(FIXTURE_NOW_ISO, -4),
  },
];

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

type SlotConfig = {
  slotId: 'foundation' | 'audience' | 'launch' | 'compound';
  state: ProductState;
  launchPhase: LaunchPhase;
  launchDate: string | null;
  launchedAt: string | null;
  milestones: RecentMilestone[];
};

const SLOTS: SlotConfig[] = [
  {
    slotId: 'foundation',
    state: 'mvp',
    launchPhase: 'foundation',
    launchDate: null,
    launchedAt: null,
    milestones: MILESTONES_EMPTY,
  },
  {
    slotId: 'audience',
    state: 'launching',
    launchPhase: 'audience',
    launchDate: LAUNCH_DATE_IN_14D,
    launchedAt: null,
    milestones: MILESTONES_PREMILESTONE,
  },
  {
    slotId: 'launch',
    state: 'launching',
    launchPhase: 'launch',
    launchDate: LAUNCH_DATE_TODAY,
    launchedAt: null,
    milestones: MILESTONES_LAUNCH_WEEK,
  },
  {
    slotId: 'compound',
    state: 'launched',
    launchPhase: 'compound',
    launchDate: null,
    launchedAt: LAUNCHED_AT_14D_AGO,
    milestones: MILESTONES_POSTLAUNCH,
  },
];

const CATEGORIES: ProductCategory[] = [
  'dev_tool',
  'saas',
  'ai_app',
  'consumer',
  'creator_tool',
];

function buildFixtures(): EquivalenceFixture[] {
  const out: EquivalenceFixture[] = [];
  for (const category of CATEGORIES) {
    for (const slot of SLOTS) {
      const copy = COPY[category];
      out.push({
        fixtureId: `${category}-${slot.slotId}`,
        productName: copy.productName,
        productDescription: copy.description,
        valueProp: copy.valueProp,
        keywords: copy.keywords,
        targetAudience: copy.targetAudience,
        category,
        state: slot.state,
        launchPhase: slot.launchPhase,
        launchDate: slot.launchDate,
        launchedAt: slot.launchedAt,
        channels: copy.channels,
        voiceProfile: null,
        recentMilestones: slot.milestones,
      });
    }
  }
  return out;
}

export const EQUIVALENCE_FIXTURES: readonly EquivalenceFixture[] = Object.freeze(
  buildFixtures(),
);
