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
 * posts. The slot-body processor skips these.
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
 * Output schema for the `slot-body` skill.
 * Produces the body (single tweet or thread) for a single planner slot.
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
