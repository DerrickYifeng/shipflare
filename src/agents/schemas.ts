import { z } from 'zod';

/**
 * Output schema for the discovery agent.
 * Each thread includes AI-scored relevance and intent dimensions.
 */
export const discoveryOutputSchema = z.object({
  threads: z.array(
    z.object({
      id: z.string(),
      community: z.string(),
      title: z.string(),
      url: z.string(),
      relevanceScore: z.number().optional(),
      scores: z.object({
        relevance: z.number(),
        intent: z.number(),
        // Computed by score_threads — optional when LLM returns JSON directly
        exposure: z.number().optional(),
        freshness: z.number().optional(),
        engagement: z.number().optional(),
      }).optional(),
      // Also accept flat relevance/intent from agents that don't use score_threads
      relevance: z.number().optional(),
      intent: z.number().optional(),
      score: z.number().optional(),
      commentCount: z.number().optional(),
      createdUtc: z.number().optional(),
      reason: z.string().optional(),
      // Original post body — Reddit selftext (already truncated to 500 chars by
      // the search tool) or tweet text. Pass-through so the UI can show the
      // full context without a second fetch. Optional because some sources
      // (HN, certain X search fallbacks) don't return a body field.
      body: z.string().optional(),
      author: z.string().optional(),
      upvotes: z.number().optional(),
      postedAt: z.string().optional(),
    }),
  ),
});

/**
 * Output schema for the draft-review agent.
 * Adversarial quality check with per-dimension pass/fail.
 */
export const draftReviewOutputSchema = z.object({
  verdict: z.enum(['PASS', 'FAIL', 'REVISE']),
  score: z.number(),
  checks: z.array(
    z.object({
      name: z.string(),
      result: z.enum(['PASS', 'FAIL']),
      detail: z.string(),
    }),
  ),
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
});

/**
 * Output schema for the analyst (deep-analysis) agent.
 * Engagement decision with confidence, strategy, and risk factors.
 */
export const analystOutputSchema = z.object({
  shouldEngage: z.boolean(),
  confidence: z.number(),
  strategy: z.enum(['reply_to_op', 'reply_to_comment', 'skip']),
  targetComment: z.string().nullable(),
  intent: z.record(z.unknown()),
  risks: z.array(z.string()),
  reason: z.string(),
});

/**
 * Output schema for the posting agent.
 * Reports whether a draft was successfully posted and verified.
 */
export const postingOutputSchema = z.object({
  success: z.boolean(),
  draftType: z.enum(['reply', 'original_post']).optional(),
  commentId: z.string().nullable(),
  postId: z.string().nullable().optional(),
  permalink: z.string().nullable(),
  url: z.string().nullable().optional(),
  verified: z.boolean(),
  shadowbanned: z.boolean(),
  error: z.string().optional(),
});

/**
 * Output schema for the run summary prompt.
 * Structured summary of an agent pipeline run.
 */
export const runSummaryOutputSchema = z.object({
  title: z.string(),
  communitiesScanned: z.array(z.string()),
  threadsFound: z.number(),
  newThreads: z.number(),
  draftsCreated: z.number(),
  topPerformingCommunities: z.array(
    z.object({
      community: z.string(),
      threadCount: z.number(),
      avgRelevance: z.number(),
    }),
  ),
  strategiesUsed: z.array(z.string()),
  failures: z.array(z.string()),
  keyInsights: z.array(z.string()),
  nextActions: z.array(z.string()),
});

/**
 * Output schema for the scout (community-discovery) agent.
 * Returns a list of communities ranked by audience fit.
 */
export const communityDiscoveryOutputSchema = z.object({
  communities: z.array(
    z.object({
      platform: z.string(),
      name: z.string(),
      subscribers: z.number().nullable().optional(),
      audienceFit: z.number(),
      activityLevel: z.number(),
      engageability: z.number(),
      reason: z.string(),
    }),
  ),
});

/**
 * Output schema for the community intelligence agent.
 * Per-community rules, hot topics, and engagement recommendation.
 */
export const communityIntelOutputSchema = z.object({
  community: z.string(),
  rules: z.object({
    allowed: z.array(z.string()),
    banned: z.array(z.string()),
    selfPromoPolicy: z.string(),
  }),
  hotTopics: z.array(z.string()),
  bestPostFormat: z.string(),
  recommendedApproach: z.enum(['reply', 'original_post', 'both', 'not_recommended']),
});

/**
 * Output schema for the content agent.
 * Includes optional postTitle for original_post type.
 *
 * `summaryReason` is a new one-sentence default-visible recap shown under the
 * reply body in the DraftCard. `whyItWorks` remains the deep strategy recap
 * shown behind a "See detailed reasoning" toggle. Optional for backwards
 * compatibility with drafts stored before the field was introduced.
 */
export const contentOutputSchema = z.object({
  replyBody: z.string(),
  postTitle: z.string().optional(),
  confidence: z.number(),
  whyItWorks: z.string(),
  summaryReason: z.string().optional(),
  ftcDisclosure: z.string(),
});

/**
 * Output schema for the reply-drafter agent.
 * Generates a high-value reply to a target account's post.
 */
export const replyDrafterOutputSchema = z.object({
  replyText: z.string(),
  confidence: z.number(),
  strategy: z.enum([
    'supportive_peer',
    'data_add',
    'contrarian',
    'question_extender',
    'anecdote',
    'dry_wit',
    'skip',
  ]),
  whyItWorks: z.string().optional(),
});

/**
 * Output schema for the content creator (content-batch skill).
 * Generates original post or thread content for the content calendar.
 *
 * `summaryReason` is the one-sentence default-visible recap; `whyItWorks`
 * is the longer strategy rationale shown behind a collapsible toggle.
 */
export const contentCreatorOutputSchema = z.object({
  tweets: z.array(z.string()),
  linkReply: z.string().nullable().optional(),
  confidence: z.number(),
  whyItWorks: z.string(),
  summaryReason: z.string().optional(),
  contentType: z.string(),
});

/**
 * Output schema for the calendar planner agent (thesis + angles model).
 *
 * The planner picks ONE thesis per week and distributes 7 angles across the days.
 * `contentType` is retained as a *format* dimension (metric/educational/…)
 * but is now a weak bias — the primary organising axis is `angle`.
 *
 * `whiteSpaceDayOffsets` lists days deliberately left un-drafted for reactive
 * posts. The draft-single-post executor skips these.
 */
export const calendarPlanOutputSchema = z.object({
  phase: z.string().min(1),
  phaseDescription: z.string().nullable().optional(),
  weeklyStrategy: z.string().min(1),
  thesis: z.string().min(8).max(280),
  thesisSource: z.enum(['milestone', 'top_reply_ratio', 'fallback', 'manual']),
  pillar: z.string().max(60).nullable().optional(),
  milestoneContext: z.string().max(500).nullable().optional(),
  fallbackMode: z
    .enum(['trigger_interview', 'teardown', 'principle_week', 'reader_week'])
    .nullable()
    .optional(),
  whiteSpaceDayOffsets: z.array(z.number().int().min(0).max(6)).max(3),
  entries: z
    .array(
      z.object({
        dayOffset: z.number().int().min(0).max(6),
        hour: z.number().int().min(0).max(23),
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
        topic: z.string().min(1).max(200),
      }),
    )
    .min(1),
});

/**
 * Output schema for the `draft-single-post` skill.
 * Produces the body (single tweet or thread) for one plan_item.
 */
export const slotBodyOutputSchema = z.object({
  tweets: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
  whyItWorks: z.string().min(1),
});

/**
 * Output schema for the engagement monitor agent.
 * Assesses mentions and drafts responses for the engagement window.
 */
export const engagementMonitorOutputSchema = z.object({
  mentions: z.array(
    z.object({
      mentionId: z.string(),
      authorUsername: z.string(),
      text: z.string(),
      shouldReply: z.boolean(),
      draftReply: z.string().optional(),
      priority: z.enum(['high', 'medium', 'low']),
    }),
  ),
});

/**
 * Output schema for the product-opportunity-judge agent.
 * Decides whether a reply draft may organically mention the user's product.
 *
 * Green-light signals are narrow: the OP must explicitly invite a tool/product
 * recommendation, be debugging a problem this product solves, complain about a
 * direct competitor's failure mode, ask for a case study, or invite a review.
 *
 * Hard mutes: milestone, vulnerable, grief, political, career-layoff.
 */
export const productOpportunityJudgeOutputSchema = z.object({
  allowMention: z.boolean(),
  signal: z.enum([
    'tool_question',
    'debug_problem_fit',
    'competitor_complaint',
    'case_study_request',
    'review_invitation',
    'milestone_celebration',
    'vulnerable_post',
    'grief_or_layoff',
    'political',
    'no_fit',
  ]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(200),
});

/**
 * Output schema for the voice-extractor agent. Consumes ≤30 sample tweets +
 * the user's structured preferences; emits a markdown style card plus
 * auxiliary metrics used for re-extraction heuristics.
 *
 * The style card is capped at 4000 chars to keep the injected voice block
 * small enough that the primary task prompt retains attention.
 */
export const voiceExtractorOutputSchema = z.object({
  styleCardMd: z.string().min(40).max(4000),
  detectedBannedWords: z.array(z.string()).max(30),
  topBigrams: z.array(z.tuple([z.string(), z.string()])).max(30),
  avgSentenceLength: z.number().positive().max(80),
  lengthHistogram: z.record(z.string(), z.number()),
  openerHistogram: z.record(z.string(), z.number()),
  confidence: z.number().min(0).max(1),
});

// ---------------------------------------------------------------------------
// Phase 5 atomic skills — output schemas
// ---------------------------------------------------------------------------

/**
 * Output schema for the `draft-email` skill. The agent emits subject + body
 * for one email, branched by `emailType`. Plain-text body is required; HTML
 * is optional so welcome / retro emails can stay plain while drip emails can
 * layer richer markup when a template system later wants it.
 */
export const draftEmailOutputSchema = z.object({
  subject: z.string().min(1).max(120),
  bodyText: z.string().min(1),
  bodyHtml: z.string().min(1).optional(),
  previewText: z.string().max(120).optional(),
});

/**
 * Output schema for the `send-email` skill. Side-effect skill — not driven
 * by an LLM. Returns `sent: false` with a machine-readable `reason` when
 * the provider env var is missing or the HTTP call fails, so callers can
 * surface the limitation without a try/catch.
 */
export const sendEmailOutputSchema = z.object({
  sent: z.boolean(),
  providerMessageId: z.string().nullable(),
  reason: z
    .enum([
      'sent',
      'no_provider',
      'provider_error',
      'invalid_recipient',
      'missing_from_address',
    ])
    .nullable(),
});

/**
 * Output schema for the `ab-test-subject` skill. Two subject variants
 * diverging on opener style, length, or concreteness — so the post-send
 * winner selection (open-rate metric) has a clean signal.
 */
export const abTestSubjectOutputSchema = z.object({
  variantA: z.object({
    subject: z.string().min(1).max(120),
    rationale: z.string().min(1).max(240),
  }),
  variantB: z.object({
    subject: z.string().min(1).max(120),
    rationale: z.string().min(1).max(240),
  }),
});

/**
 * Output schema for the `draft-waitlist-page` skill. HTML string + the copy
 * broken into addressable pieces so the caller can stitch into a CMS/MDX
 * template without re-parsing the HTML.
 */
export const draftWaitlistPageOutputSchema = z.object({
  html: z.string().min(1),
  copy: z.object({
    headline: z.string().min(1).max(120),
    subheadline: z.string().min(1).max(240),
    cta: z.string().min(1).max(40),
    valueBullets: z.array(z.string().min(1)).min(2).max(5),
    socialProofLine: z.string().nullable().optional(),
  }),
});

/**
 * Output schema for the `draft-hunter-outreach` skill. One PH hunter DM,
 * personalized to the recipient's profile. Short-by-design: PH hunters
 * ignore walls of text.
 */
export const draftHunterOutreachOutputSchema = z.object({
  dm: z.string().min(40).max(700),
  personalizationHook: z.string().min(1).max(240),
  confidence: z.number().min(0).max(1),
});

/**
 * Output schema for the `draft-launch-day-comment` skill. The maker's
 * first comment on their PH launch — usually pinned, sets tone.
 */
export const draftLaunchDayCommentOutputSchema = z.object({
  comment: z.string().min(80).max(1200),
  openingHookKind: z.enum([
    'origin_story',
    'problem_statement',
    'contrarian_claim',
    'vulnerable_confession',
  ]),
});

/**
 * Output schema for the `generate-launch-asset-brief` skill. Text brief
 * for a designer to produce the actual image/video; the skill does not
 * generate the asset. `assetType` scopes the brief.
 */
export const launchAssetBriefOutputSchema = z.object({
  assetType: z.enum(['gallery_image', 'video_30s', 'og_image', 'demo_gif']),
  title: z.string().min(1).max(120),
  brief: z.string().min(40),
  shotList: z.array(z.string().min(1)).min(1).max(12),
  mustInclude: z.array(z.string().min(1)),
  mustAvoid: z.array(z.string().min(1)),
  referenceInspirations: z.array(z.string().min(1)).max(6).optional(),
});

/**
 * Output schema for the `build-launch-runsheet` skill. Hourly beats from
 * launch-day start through completion (typically T-1h through T+12h).
 * Each beat is a `plan_items.kind='runsheet_beat'` candidate row.
 */
export const launchRunsheetBeatSchema = z.object({
  hourOffset: z.number().int().min(-6).max(48),
  channel: z.enum(['x', 'reddit', 'email', 'producthunt', 'slack', 'other']),
  action: z.string().min(1).max(200),
  description: z.string().min(1),
  skillName: z.string().nullable(),
  priority: z.enum(['critical', 'high', 'normal']),
});
export const launchRunsheetOutputSchema = z.object({
  launchDate: z.string().min(1),
  beats: z.array(launchRunsheetBeatSchema).min(6),
  notes: z.string().nullable().optional(),
});

/**
 * Output schema for the `extract-milestone-from-commits` skill.
 * Takes raw git log output; returns the single highest-signal milestone
 * or `null` when the window contains only chore/refactor activity.
 */
export const extractMilestoneOutputSchema = z.object({
  milestone: z
    .object({
      title: z.string().min(1).max(120),
      summary: z.string().min(1).max(400),
      source: z.enum(['commit', 'pr', 'release']),
      sourceRef: z.string().nullable(),
      confidence: z.number().min(0).max(1),
    })
    .nullable(),
});

/**
 * Output schema for the `fetch-community-rules` skill. Wraps the existing
 * reddit-get-rules tool with an LLM-derived summary the planner can read
 * without parsing the raw rule text.
 */
export const communityRulesOutputSchema = z.object({
  community: z.string().min(1),
  rulesRaw: z.array(z.string().min(1)),
  selfPromotionPolicy: z.enum([
    'forbidden',
    'restricted',
    'tolerated',
    'welcomed',
    'unknown',
  ]),
  keyConstraints: z.array(z.string().min(1)).max(8),
  recommendation: z.string().min(1).max(400),
});

/**
 * Output schema for the `fetch-community-hot-posts` skill. Wraps the
 * existing reddit-hot-posts tool with an LLM insight over post patterns.
 */
export const communityHotPostsOutputSchema = z.object({
  community: z.string().min(1),
  topFormats: z.array(z.string().min(1)).min(1).max(6),
  avgEngagement: z.object({
    upvotes: z.number().min(0),
    comments: z.number().min(0),
  }),
  insight: z.string().min(1).max(600),
  samplePostIds: z.array(z.string()).max(10),
});

/**
 * Output schema for the `analytics-summarize` skill. Replaces the old
 * `analyst` agent. Plain-English weekly summary + structured numbers.
 */
export const analyticsSummarizeOutputSchema = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  headline: z.string().min(1).max(240),
  summaryMd: z.string().min(1),
  highlights: z.array(z.string().min(1)).max(6),
  lowlights: z.array(z.string().min(1)).max(6),
  metrics: z.object({
    postsPublished: z.number().int().min(0),
    repliesSent: z.number().int().min(0),
    impressions: z.number().int().min(0),
    engagementRate: z.number().min(0).max(1),
    topPostId: z.string().nullable(),
  }),
  recommendedNextMoves: z.array(z.string().min(1)).max(5),
});

/**
 * Output schema for the `identify-top-supporters` skill. Takes engagement
 * data and ranks accounts that repeatedly showed up across the period.
 */
export const topSupportersOutputSchema = z.object({
  supporters: z
    .array(
      z.object({
        username: z.string().min(1),
        platform: z.string().min(1),
        interactionCount: z.number().int().positive(),
        kinds: z.array(
          z.enum(['reply', 'repost', 'quote', 'like', 'bookmark', 'mention']),
        ),
        lastSeenAt: z.string(),
        notes: z.string().nullable(),
      }),
    )
    .max(30),
});

/**
 * Output schema for the `generate-interview-questions` skill. Phase-aware
 * customer-interview script — planner schedules these during foundation /
 * audience phases and again for retention interviews in compound / steady.
 */
export const interviewQuestionsOutputSchema = z.object({
  intent: z.enum([
    'discovery',
    'activation',
    'retention',
    'win_back',
    'pricing',
  ]),
  questions: z.array(z.string().min(1)).length(10),
  followUpPrompts: z.array(z.string().min(1)).max(10),
});

/**
 * Output schema for the `compile-retrospective` skill. Long-form retro post,
 * optionally paired with a social-ready digest.
 */
export const retrospectiveOutputSchema = z.object({
  longForm: z.string().min(400),
  socialDigest: z.string().max(1000).nullable(),
  sections: z.object({
    whatShipped: z.string().min(1),
    whatWorked: z.string().min(1),
    whatDidNot: z.string().min(1),
    whatsNext: z.string().min(1),
  }),
});

/**
 * Output schema for the `classify-thread-sentiment` skill. One thread →
 * one sentiment label with a short rationale, so the planner can skew
 * reply-angle choice.
 */
export const threadSentimentOutputSchema = z.object({
  sentiment: z.enum(['pos', 'neg', 'neutral', 'mixed']),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(240),
});

// ---------------------------------------------------------------------------
// Phase 6 — strategic + tactical planner output schemas
// ---------------------------------------------------------------------------

/**
 * A single milestone on the strategic arc. `atDayOffset` is relative to
 * launch day (negative = pre-launch, positive = post-launch). `phase`
 * is the phase the milestone belongs to — so the tactical planner knows
 * when to surface it.
 */
export const strategicMilestoneSchema = z.object({
  atDayOffset: z.number().int(),
  title: z.string().min(1).max(140),
  successMetric: z.string().min(1).max(240),
  phase: z.enum([
    'foundation',
    'audience',
    'momentum',
    'launch',
    'compound',
    'steady',
  ]),
});

/**
 * One week of the thesis arc. The tactical planner reads
 * `thesisArc[thisWeekIndex].theme` and anchors every content_post to it.
 */
export const strategicThesisWeekSchema = z.object({
  weekStart: z.string().min(1), // ISO, Monday 00:00 UTC
  theme: z.string().min(1).max(240),
  angleMix: z
    .array(
      z.enum([
        'claim',
        'story',
        'contrarian',
        'howto',
        'data',
        'case',
        'synthesis',
      ]),
    )
    .min(1)
    .max(7),
});

/**
 * Channel-level cadence. `perWeek` is the planned post count. `preferredHours`
 * is a small list of UTC hours the planner should prefer when allocating
 * slots. `preferredCommunities` applies to reddit only.
 */
export const strategicChannelCadenceSchema = z.object({
  perWeek: z.number().int().min(0).max(21),
  preferredHours: z.array(z.number().int().min(0).max(23)).min(1).max(6),
  preferredCommunities: z.array(z.string().min(1)).nullish(),
});

/**
 * Output schema for the strategic-planner agent. Mirrors the
 * `strategic_paths` table's jsonb columns so the caller can write
 * directly without remapping.
 */
export const strategicPathSchema = z.object({
  narrative: z.string().min(200).max(2400),
  milestones: z.array(strategicMilestoneSchema).min(3).max(12),
  thesisArc: z.array(strategicThesisWeekSchema).min(1).max(12),
  contentPillars: z.array(z.string().min(1).max(60)).min(3).max(4),
  channelMix: z
    .object({
      x: strategicChannelCadenceSchema.nullish(),
      reddit: strategicChannelCadenceSchema.nullish(),
      email: strategicChannelCadenceSchema.nullish(),
    })
    .refine((c) => Object.values(c).some((v) => v != null), {
      message: 'channelMix must include at least one active channel',
    }),
  phaseGoals: z.object({
    foundation: z.string().min(1).max(240).nullish(),
    audience: z.string().min(1).max(240).nullish(),
    momentum: z.string().min(1).max(240).nullish(),
    launch: z.string().min(1).max(240).nullish(),
    compound: z.string().min(1).max(240).nullish(),
    steady: z.string().min(1).max(240).nullish(),
  }),
});

export type StrategicMilestone = z.infer<typeof strategicMilestoneSchema>;
export type StrategicThesisWeek = z.infer<typeof strategicThesisWeekSchema>;
export type StrategicChannelCadence = z.infer<
  typeof strategicChannelCadenceSchema
>;
export type StrategicPath = z.infer<typeof strategicPathSchema>;

export type DraftEmailOutput = z.infer<typeof draftEmailOutputSchema>;
export type SendEmailOutput = z.infer<typeof sendEmailOutputSchema>;
export type AbTestSubjectOutput = z.infer<typeof abTestSubjectOutputSchema>;
export type DraftWaitlistPageOutput = z.infer<typeof draftWaitlistPageOutputSchema>;
export type DraftHunterOutreachOutput = z.infer<typeof draftHunterOutreachOutputSchema>;
export type DraftLaunchDayCommentOutput = z.infer<typeof draftLaunchDayCommentOutputSchema>;
export type LaunchAssetBriefOutput = z.infer<typeof launchAssetBriefOutputSchema>;
export type LaunchRunsheetOutput = z.infer<typeof launchRunsheetOutputSchema>;
export type ExtractMilestoneOutput = z.infer<typeof extractMilestoneOutputSchema>;
export type CommunityRulesOutput = z.infer<typeof communityRulesOutputSchema>;
export type CommunityHotPostsOutput = z.infer<typeof communityHotPostsOutputSchema>;
export type AnalyticsSummarizeOutput = z.infer<typeof analyticsSummarizeOutputSchema>;
export type TopSupportersOutput = z.infer<typeof topSupportersOutputSchema>;
export type InterviewQuestionsOutput = z.infer<typeof interviewQuestionsOutputSchema>;
export type RetrospectiveOutput = z.infer<typeof retrospectiveOutputSchema>;
export type ThreadSentimentOutput = z.infer<typeof threadSentimentOutputSchema>;

export type DiscoveryOutput = z.infer<typeof discoveryOutputSchema>;
export type CommunityDiscoveryOutput = z.infer<typeof communityDiscoveryOutputSchema>;
export type CommunityIntelOutput = z.infer<typeof communityIntelOutputSchema>;
export type ContentOutput = z.infer<typeof contentOutputSchema>;
export type DraftReviewOutput = z.infer<typeof draftReviewOutputSchema>;
export type AnalystOutput = z.infer<typeof analystOutputSchema>;
export type PostingOutput = z.infer<typeof postingOutputSchema>;
export type RunSummaryOutput = z.infer<typeof runSummaryOutputSchema>;
export type ReplyDrafterOutput = z.infer<typeof replyDrafterOutputSchema>;
export type ContentCreatorOutput = z.infer<typeof contentCreatorOutputSchema>;
export type CalendarPlanOutput = z.infer<typeof calendarPlanOutputSchema>;
export type SlotBodyOutput = z.infer<typeof slotBodyOutputSchema>;
export type EngagementMonitorOutput = z.infer<typeof engagementMonitorOutputSchema>;
export type ProductOpportunityJudgeOutput = z.infer<typeof productOpportunityJudgeOutputSchema>;
export type VoiceExtractorOutput = z.infer<typeof voiceExtractorOutputSchema>;
