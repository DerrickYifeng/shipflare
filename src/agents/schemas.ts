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
 */
export const contentOutputSchema = z.object({
  replyBody: z.string(),
  postTitle: z.string().optional(),
  confidence: z.number(),
  whyItWorks: z.string(),
  ftcDisclosure: z.string(),
});

/**
 * Output schema for the reply-drafter agent.
 * Generates a high-value reply to a target account's post.
 */
export const replyDrafterOutputSchema = z.object({
  replyText: z.string(),
  confidence: z.number(),
  strategy: z.string(),
  whyItWorks: z.string(),
});

/**
 * Output schema for the content creator (content-batch skill).
 * Generates original post or thread content for the content calendar.
 */
export const contentCreatorOutputSchema = z.object({
  tweets: z.array(z.string()),
  linkReply: z.string().optional(),
  confidence: z.number(),
  whyItWorks: z.string(),
  contentType: z.string(),
});

/**
 * Output schema for the calendar planner agent.
 * Generates a strategic weekly content plan based on growth phase.
 */
export const calendarPlanOutputSchema = z.object({
  phase: z.number(),
  phaseDescription: z.string(),
  weeklyStrategy: z.string(),
  entries: z.array(
    z.object({
      dayOffset: z.number(),
      hour: z.number(),
      contentType: z.string(),
      topic: z.string(),
      strategicGoal: z.string(),
      guidelines: z.array(z.string()),
    }),
  ),
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
export type EngagementMonitorOutput = z.infer<typeof engagementMonitorOutputSchema>;
