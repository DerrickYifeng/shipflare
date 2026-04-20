/**
 * Machine-readable skill catalog.
 *
 * Consumed by:
 *   - The tactical-planner prompt (Phase 6) — so the planner knows which
 *     skills exist, what kinds of plan_items they execute, and what shape
 *     `plan_items.params` must take for each.
 *   - The plan-execute dispatcher (Phase 7) — routes plan_items to the
 *     matching skill based on `skillName` (which must match an entry's
 *     `name` field here).
 *
 * Hand-maintained for v1. Auto-generation from SKILL.md frontmatter is a
 * nice-to-have for Phase 5+ once the skill set stops churning.
 *
 * Adding a new skill:
 *   1. Land the skill dir (SKILL.md + agent ref + references/).
 *   2. Add an output schema to `src/agents/schemas.ts` if one doesn't exist.
 *   3. Define an input schema here (or import from schemas.ts).
 *   4. Append a new `SKILL_CATALOG` entry with accurate `supportedKinds`
 *      and `channels` arrays.
 *   5. Run `pnpm test src/skills/__tests__/catalog` to validate.
 */

import { z, type ZodTypeAny } from 'zod';
import {
  discoveryOutputSchema,
  draftReviewOutputSchema,
  postingOutputSchema,
  replyDrafterOutputSchema,
  slotBodyOutputSchema,
  voiceExtractorOutputSchema,
  abTestSubjectOutputSchema,
  draftEmailOutputSchema,
  sendEmailOutputSchema,
  draftWaitlistPageOutputSchema,
  draftHunterOutreachOutputSchema,
  draftLaunchDayCommentOutputSchema,
  launchAssetBriefOutputSchema,
  launchRunsheetOutputSchema,
  extractMilestoneOutputSchema,
  communityRulesOutputSchema,
  communityHotPostsOutputSchema,
  analyticsSummarizeOutputSchema,
  topSupportersOutputSchema,
  interviewQuestionsOutputSchema,
} from '@/agents/schemas';

/**
 * Mirror of the `plan_item_kind` Postgres enum. Kept here as a string-literal
 * union so catalog entries type-check the `supportedKinds` array without
 * needing to import the Drizzle enum at build time.
 */
export type PlanItemKind =
  | 'content_post'
  | 'content_reply'
  | 'email_send'
  | 'interview'
  | 'setup_task'
  | 'launch_asset'
  | 'runsheet_beat'
  | 'metrics_compute'
  | 'analytics_summary';

export interface SkillMeta {
  /** Skill name — MUST match the `name:` field in the SKILL.md frontmatter. */
  name: string;
  /** Short human-readable summary, shown in planner prompts. */
  description: string;
  /** Zod schema describing the `input` the skill-runner must receive. */
  inputSchema: ZodTypeAny;
  /** Zod schema for the skill's output. Optional for skills that only side-effect. */
  outputSchema?: ZodTypeAny;
  /**
   * Which `plan_items.kind` values this skill can execute. The dispatcher
   * uses this to validate that a tactical-planner-emitted item is legal to
   * route to the named skill.
   */
  supportedKinds: PlanItemKind[];
  /**
   * Optional platform filter. Absent / empty = platform-agnostic. Otherwise
   * the catalog advertises which channel identifiers the skill handles so the
   * planner can skip it for other platforms.
   */
  channels?: string[];
}

// ---------------------------------------------------------------------------
// Minimal input schemas — one per catalog entry. Prose input shapes still
// live in each SKILL.md for humans; these are the runtime contract.
// Tightening `z.unknown()` members to real fields is a Phase 5 cleanup.
// ---------------------------------------------------------------------------

const productContextSchema = z.object({
  name: z.string(),
  description: z.string(),
  valueProp: z.string().nullable().optional(),
  keywords: z.array(z.string()),
  currentPhase: z.string().optional(),
});

const draftSinglePostInput = z.object({
  // TODO(phase-5): widen to z.enum(['x', 'reddit']) once the Reddit content
  // guide + agent-prompt branch land. Locked to 'x' here so callers that
  // slip through the catalog channel filter get a Zod validation error
  // upfront instead of crashing mid-LLM call.
  platform: z.literal('x'),
  contentType: z.enum([
    'metric',
    'educational',
    'engagement',
    'product',
    'thread',
  ]),
  angle: z.enum([
    'claim',
    'story',
    'contrarian',
    'howto',
    'data',
    'case',
    'synthesis',
  ]),
  topic: z.string().min(1),
  thesis: z.string().min(1),
  thesisSource: z.enum(['milestone', 'top_reply_ratio', 'fallback', 'manual']),
  pillar: z.string().nullable().optional(),
  product: productContextSchema,
  recentPostHistory: z.array(z.string()),
  priorAnglesThisWeek: z.array(
    z.object({
      angle: z.string(),
      topic: z.string(),
      body: z.string(),
    }),
  ),
  isThread: z.boolean(),
  voiceBlock: z.string().nullable(),
});

const draftSingleReplyInput = z.object({
  tweets: z
    .array(
      z.object({
        tweetId: z.string().min(1),
        tweetText: z.string(),
        authorUsername: z.string(),
        platform: z.literal('x'),
        productName: z.string(),
        productDescription: z.string(),
        valueProp: z.string().nullable().optional(),
        keywords: z.array(z.string()),
        canMentionProduct: z.boolean(),
        voiceBlock: z.string().nullable(),
        repairPrompt: z.string().optional(),
      }),
    )
    .min(1),
});

const discoveryInput = z.object({
  platform: z.string().min(1),
  source: z.string().min(1),
  product: productContextSchema,
});

const draftReviewInput = z.object({
  platform: z.string().min(1),
  kind: z.enum(['reply', 'original_post']),
  replyBody: z.string(),
  thread: z
    .object({
      title: z.string().nullable().optional(),
      body: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
    })
    .optional(),
  product: productContextSchema,
});

const postingInput = z.object({
  draftId: z.string().min(1),
  channelId: z.string().min(1),
  platform: z.string().min(1),
});

const voiceExtractorInput = z.object({
  userId: z.string().min(1),
  platform: z.string().min(1),
  samplePosts: z.array(z.string()).min(1),
});

// ---------------------------------------------------------------------------
// Phase 5 — email atoms
// ---------------------------------------------------------------------------

const recipientSchema = z.object({
  firstName: z.string().optional(),
  email: z.string().email(),
  context: z.string().optional(),
  signupSource: z.string().optional(),
});

const draftEmailInput = z.object({
  emailType: z.enum([
    'welcome',
    'thank_you',
    'retro_week_1',
    'retro_launch',
    'drip_week_1',
    'drip_week_2',
    'drip_retention',
    'win_back',
  ]),
  product: productContextSchema,
  recipient: recipientSchema,
  signature: z.object({
    founderName: z.string().min(1),
    founderTitle: z.string().optional(),
  }),
  constraints: z
    .object({
      maxWords: z.number().int().positive().optional(),
      includeCTAHref: z.string().url().optional(),
      mustMention: z.array(z.string()).optional(),
      mustAvoid: z.array(z.string()).optional(),
    })
    .optional(),
  voiceBlock: z.string().nullable(),
});

const sendEmailInput = z.object({
  to: z.string().email(),
  from: z.string().optional(),
  replyTo: z.string().email().optional(),
  subject: z.string().min(1).max(120),
  bodyText: z.string().min(1),
  bodyHtml: z.string().optional(),
  tag: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

const abTestSubjectInput = z.object({
  emailType: z.string().min(1),
  currentSubject: z.string().min(1).max(120),
  bodyText: z.string().min(1),
  product: productContextSchema,
  voiceBlock: z.string().nullable(),
  constraints: z
    .object({
      maxChars: z.number().int().positive().optional(),
      avoidEmojis: z.boolean().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Phase 5 — launch asset atoms
// ---------------------------------------------------------------------------

const draftWaitlistPageInput = z.object({
  product: productContextSchema.extend({
    url: z.string().url().optional(),
  }),
  audience: z.object({
    primaryICP: z.string().min(1),
    secondaryICP: z.string().optional(),
  }),
  launchTarget: z
    .object({
      dateISO: z.string().optional(),
      milestoneDescription: z.string().optional(),
    })
    .optional(),
  socialProof: z
    .object({
      accounts: z
        .array(
          z.object({
            username: z.string().min(1),
            platform: z.string().min(1),
            followers: z.number().int().nonnegative().optional(),
          }),
        )
        .optional(),
      quoteLine: z.string().optional(),
    })
    .optional(),
  voiceBlock: z.string().nullable(),
  constraints: z
    .object({
      maxHeadlineChars: z.number().int().positive().optional(),
      avoidStockPhrases: z.array(z.string()).optional(),
      includeEmailCapture: z.boolean(),
    })
    .optional(),
});

const draftHunterOutreachInput = z.object({
  hunterProfile: z.object({
    username: z.string().min(1),
    platform: z.enum(['producthunt', 'x']),
    displayName: z.string().optional(),
    bio: z.string().optional(),
    recentHunts: z
      .array(
        z.object({
          productName: z.string().min(1),
          hunted: z.string(),
        }),
      )
      .optional(),
    recentComments: z
      .array(
        z.object({
          text: z.string().min(1),
          context: z.string().min(1),
        }),
      )
      .optional(),
    recentTweets: z.array(z.string().min(1)).optional(),
    followers: z.number().int().nonnegative().optional(),
  }),
  product: productContextSchema.extend({
    url: z.string().url().optional(),
  }),
  launchTarget: z.object({
    dateISO: z.string().min(1),
    category: z.string().optional(),
  }),
  founder: z.object({
    name: z.string().min(1),
    x: z.string().optional(),
  }),
  voiceBlock: z.string().nullable(),
});

const draftLaunchDayCommentInput = z.object({
  product: productContextSchema.extend({
    url: z.string().url().optional(),
  }),
  founder: z.object({
    name: z.string().min(1),
    why: z.string().min(1),
    background: z.string().optional(),
  }),
  launchContext: z.object({
    dateISO: z.string().min(1),
    buildingDurationWeeks: z.number().int().positive().optional(),
    firstMetric: z
      .object({
        label: z.string().min(1),
        value: z.string().min(1),
      })
      .optional(),
  }),
  voiceBlock: z.string().nullable(),
});

const launchAssetBriefInput = z.object({
  assetType: z.enum(['gallery_image', 'video_30s', 'og_image', 'demo_gif']),
  product: productContextSchema.extend({
    url: z.string().url().optional(),
  }),
  audience: z.object({
    primaryICP: z.string().min(1),
  }),
  voice: z.object({
    founderName: z.string().min(1),
    styleAdjectives: z.array(z.string()).optional(),
  }),
  constraints: z.object({
    brandColors: z.array(z.string()).optional(),
    brandFont: z.string().optional(),
    maxAssetCost: z.number().nonnegative().optional(),
    avoidMotifs: z.array(z.string()).optional(),
  }),
  referenceLaunches: z
    .array(
      z.object({
        productName: z.string().min(1),
        note: z.string().min(1),
      }),
    )
    .optional(),
});

const buildLaunchRunsheetInput = z.object({
  launchDate: z.string().min(1),
  launchTimezone: z.string().min(1),
  product: productContextSchema,
  channels: z
    .array(z.enum(['x', 'reddit', 'email', 'producthunt', 'slack']))
    .min(1),
  audience: z
    .object({
      waitlistCount: z.number().int().nonnegative().optional(),
      topSupporterCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
  assets: z.object({
    hunterOutreachReady: z.boolean(),
    launchCommentReady: z.boolean(),
    waitlistEmailReady: z.boolean(),
    metricsDashboardUrl: z.string().url().optional(),
  }),
  constraints: z
    .object({
      quietHours: z.tuple([z.number().int(), z.number().int()]).optional(),
      maxBeatsPerHour: z.number().int().positive().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Phase 5 — research atoms
// ---------------------------------------------------------------------------

const extractMilestoneInput = z.object({
  window: z.object({
    since: z.string().min(1),
    until: z.string().min(1),
  }),
  entries: z
    .array(
      z.object({
        sha: z.string().min(1),
        message: z.string().min(1),
        author: z.string().min(1),
        timestamp: z.string().min(1),
        type: z.enum(['commit', 'pr', 'release']).optional(),
        ref: z.string().optional(),
      }),
    )
    .min(1),
  product: z.object({
    name: z.string().min(1),
    valueProp: z.string().nullable(),
  }),
});

const fetchCommunityRulesInput = z.object({
  community: z.string().min(1),
  product: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    valueProp: z.string().nullable(),
  }),
});

const fetchCommunityHotPostsInput = z.object({
  community: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  product: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    valueProp: z.string().nullable(),
  }),
});

const analyticsSummarizeInput = z.object({
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
  product: productContextSchema,
  rawMetrics: z.object({
    postsPublished: z.number().int().nonnegative(),
    repliesSent: z.number().int().nonnegative(),
    impressions: z.number().int().nonnegative(),
    engagements: z.number().int().nonnegative(),
    followersDelta: z.number().int(),
    topPost: z
      .object({
        id: z.string().min(1),
        snippet: z.string().min(1),
        impressions: z.number().int().nonnegative(),
        engagements: z.number().int().nonnegative(),
      })
      .optional(),
    perChannel: z
      .record(
        z.string(),
        z.object({
          postsPublished: z.number().int().nonnegative(),
          impressions: z.number().int().nonnegative(),
        }),
      )
      .optional(),
  }),
  prior: z
    .object({
      postsPublished: z.number().int().nonnegative(),
      repliesSent: z.number().int().nonnegative(),
      impressions: z.number().int().nonnegative(),
      engagements: z.number().int().nonnegative(),
    })
    .optional(),
  voiceBlock: z.string().nullable(),
});

const identifyTopSupportersInput = z.object({
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
  events: z
    .array(
      z.object({
        username: z.string().min(1),
        platform: z.string().min(1),
        kind: z.enum([
          'reply',
          'repost',
          'quote',
          'like',
          'bookmark',
          'mention',
        ]),
        timestamp: z.string().min(1),
        note: z.string().optional(),
      }),
    ),
  productName: z.string().min(1),
});

const generateInterviewQuestionsInput = z.object({
  intent: z.enum([
    'discovery',
    'activation',
    'retention',
    'win_back',
    'pricing',
  ]),
  product: productContextSchema,
  interviewee: z.object({
    role: z.string().optional(),
    cohort: z.string().optional(),
    context: z.string().optional(),
  }),
  constraints: z
    .object({
      excludeTopics: z.array(z.string()).optional(),
      focusTopics: z.array(z.string()).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const SKILL_CATALOG: readonly SkillMeta[] = [
  {
    name: 'draft-single-post',
    description:
      'Draft one original post (tweet or thread) for a single plan_item of kind content_post. One LLM call per item.',
    inputSchema: draftSinglePostInput,
    outputSchema: slotBodyOutputSchema,
    supportedKinds: ['content_post'],
    // TODO(phase-5): add 'reddit' once the agent prompt + reddit-content-guide land.
    channels: ['x'],
  },
  {
    name: 'draft-single-reply',
    description:
      'Draft one reply to a monitored post or discovered thread. One LLM call per item, runs the product-opportunity-judge pre-pass and validator hardening downstream.',
    inputSchema: draftSingleReplyInput,
    outputSchema: replyDrafterOutputSchema,
    supportedKinds: ['content_reply'],
    channels: ['x'],
  },
  {
    name: 'discovery',
    description:
      'Search a single platform source (subreddit or X query) for on-topic threads and score them.',
    inputSchema: discoveryInput,
    outputSchema: discoveryOutputSchema,
    // Discovery is not directly scheduled via plan_items today — it runs from
    // the search-source fan-out. Listed in the catalog so the dispatcher can
    // still resolve its name if we later wire discovery under a plan_items
    // kind (e.g., setup_task). Empty supportedKinds means "not
    // planner-schedulable" for v1.
    supportedKinds: [],
  },
  {
    name: 'draft-review',
    description:
      'Adversarial quality check for a drafted post or reply. Returns pass/fail per dimension and suggestions.',
    inputSchema: draftReviewInput,
    outputSchema: draftReviewOutputSchema,
    // Like discovery, this is an inline quality gate rather than a
    // plan_items step. The dispatcher will chain it between
    // drafted → ready_for_review for content_post / content_reply items.
    supportedKinds: [],
  },
  {
    name: 'posting',
    description:
      'Publish an approved draft to its platform. Serial worker — never retried, to avoid duplicate publishes.',
    inputSchema: postingInput,
    outputSchema: postingOutputSchema,
    // Posting is the terminal execute-phase step for content_post and
    // content_reply, but the dispatcher selects it directly from the
    // item's execution phase rather than the tactical-planner's skillName
    // field, so it doesn't advertise supportedKinds here.
    supportedKinds: [],
  },
  {
    name: 'voice-extractor',
    description:
      'Extract a voice profile (tone, signature phrases, banned phrases) from a sample of the user\'s historical posts.',
    inputSchema: voiceExtractorInput,
    outputSchema: voiceExtractorOutputSchema,
    supportedKinds: ['setup_task'],
  },

  // --- Phase 5: email atoms ---
  {
    name: 'ab-test-subject',
    description:
      'Generate two subject-line variants (A/B) for one drafted email. Variants must diverge on opener / specificity / length / framing.',
    inputSchema: abTestSubjectInput,
    outputSchema: abTestSubjectOutputSchema,
    // Inline utility — the dispatcher inserts it between draft-email and
    // send-email when the email-type is worth testing.
    supportedKinds: [],
  },
  {
    name: 'draft-email',
    description:
      'Draft one lifecycle / transactional email (welcome, thank-you, retro, drip, win-back). One LLM call per email.',
    inputSchema: draftEmailInput,
    outputSchema: draftEmailOutputSchema,
    supportedKinds: ['email_send'],
  },
  {
    name: 'send-email',
    description:
      'Send a drafted email via Resend. Side-effect skill — no LLM. Short-circuits with reason=no_provider when RESEND_API_KEY is absent.',
    inputSchema: sendEmailInput,
    outputSchema: sendEmailOutputSchema,
    supportedKinds: ['email_send'],
  },

  // --- Phase 5: launch asset atoms ---
  {
    name: 'build-launch-runsheet',
    description:
      'Produce the hourly run-of-show for launch day. Each beat becomes a plan_items.kind=runsheet_beat row, optionally chained to another atomic skill via skillName.',
    inputSchema: buildLaunchRunsheetInput,
    outputSchema: launchRunsheetOutputSchema,
    supportedKinds: ['launch_asset'],
  },
  {
    name: 'draft-hunter-outreach',
    description:
      'Draft one personalized DM to one Product Hunt hunter. Hard-requires specific personalization or emits confidence < 0.4.',
    inputSchema: draftHunterOutreachInput,
    outputSchema: draftHunterOutreachOutputSchema,
    supportedKinds: ['launch_asset'],
  },
  {
    name: 'draft-launch-day-comment',
    description:
      "Draft the maker's pinned first comment for a Product Hunt launch. Hook kind is one of origin_story / problem_statement / contrarian_claim / vulnerable_confession.",
    inputSchema: draftLaunchDayCommentInput,
    outputSchema: draftLaunchDayCommentOutputSchema,
    supportedKinds: ['launch_asset'],
  },
  {
    name: 'draft-waitlist-page',
    description:
      'Draft HTML + addressable copy for one waitlist landing page. Returns both assembled HTML and a structured copy block.',
    inputSchema: draftWaitlistPageInput,
    outputSchema: draftWaitlistPageOutputSchema,
    supportedKinds: ['launch_asset'],
  },
  {
    name: 'generate-launch-asset-brief',
    description:
      'Text-only brief for a designer / video team to execute against. Does NOT render the asset. Branches by assetType (gallery_image / video_30s / og_image / demo_gif).',
    inputSchema: launchAssetBriefInput,
    outputSchema: launchAssetBriefOutputSchema,
    supportedKinds: ['launch_asset'],
  },

  // --- Phase 5: research atoms ---
  {
    name: 'analytics-summarize',
    description:
      "Turn a week of raw metrics into a planner-consumable summary. Replaces the retired 'analyst' agent; output feeds the Today dashboard and the tactical planner's next-week moves.",
    inputSchema: analyticsSummarizeInput,
    outputSchema: analyticsSummarizeOutputSchema,
    supportedKinds: ['analytics_summary'],
  },
  {
    name: 'extract-milestone-from-commits',
    description:
      'Pick the single highest-signal milestone from a window of git activity. Returns { milestone: null } for chore-only windows.',
    inputSchema: extractMilestoneInput,
    outputSchema: extractMilestoneOutputSchema,
    // Research skill feeding the tactical planner's thesis pass; not a
    // plan_items row itself.
    supportedKinds: [],
  },
  {
    name: 'fetch-community-hot-posts',
    description:
      "Read a community's current hot posts; return top formats, average engagement, and one actionable insight for the drafting path.",
    inputSchema: fetchCommunityHotPostsInput,
    outputSchema: communityHotPostsOutputSchema,
    supportedKinds: [],
    channels: ['reddit'],
  },
  {
    name: 'fetch-community-rules',
    description:
      "Read a subreddit's rules and classify self-promotion policy into forbidden / restricted / tolerated / welcomed / unknown.",
    inputSchema: fetchCommunityRulesInput,
    outputSchema: communityRulesOutputSchema,
    supportedKinds: [],
    channels: ['reddit'],
  },
  {
    name: 'generate-interview-questions',
    description:
      'Exactly 10 customer-interview questions tailored to phase + intent (discovery / activation / retention / win_back / pricing) + up to 10 reactive follow-up prompts.',
    inputSchema: generateInterviewQuestionsInput,
    outputSchema: interviewQuestionsOutputSchema,
    supportedKinds: ['interview'],
  },
  {
    name: 'identify-top-supporters',
    description:
      'Rank up to 30 accounts by weighted engagement events within a period. Weights: reply/quote/mention=4, repost/bookmark=2, like=1.',
    inputSchema: identifyTopSupportersInput,
    outputSchema: topSupportersOutputSchema,
    supportedKinds: ['analytics_summary'],
  },
];

/**
 * O(1) lookup helper — returns the catalog entry for a given skill name,
 * or `undefined` when the skill isn't registered. The dispatcher should
 * treat an undefined result as a fatal contract error (tactical-planner
 * emitted an unknown skillName) rather than silently skipping the item.
 */
export function findSkill(name: string): SkillMeta | undefined {
  return SKILL_CATALOG.find((s) => s.name === name);
}

/**
 * Returns the skills that can execute a given plan_item kind on an optional
 * channel. The tactical-planner uses this to pick `skillName` when emitting
 * plan_items; supplying a channel filters skills that advertise a `channels`
 * list. A skill with no `channels` field is treated as channel-agnostic.
 */
export function skillsForKind(
  kind: PlanItemKind,
  channel?: string,
): SkillMeta[] {
  return SKILL_CATALOG.filter((s) => {
    if (!s.supportedKinds.includes(kind)) return false;
    if (!channel) return true;
    if (!s.channels || s.channels.length === 0) return true;
    return s.channels.includes(channel);
  });
}
