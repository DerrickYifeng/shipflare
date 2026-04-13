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
        exposure: z.number(),
        freshness: z.number(),
        engagement: z.number(),
      }).optional(),
      // Also accept flat relevance/intent from agents that don't use score_threads
      relevance: z.number().optional(),
      intent: z.number().optional(),
      score: z.number().optional(),
      commentCount: z.number().optional(),
      createdUtc: z.number().optional(),
      reason: z.string(),
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

export type DiscoveryOutput = z.infer<typeof discoveryOutputSchema>;
export type CommunityDiscoveryOutput = z.infer<typeof communityDiscoveryOutputSchema>;
export type CommunityIntelOutput = z.infer<typeof communityIntelOutputSchema>;
export type ContentOutput = z.infer<typeof contentOutputSchema>;
export type DraftReviewOutput = z.infer<typeof draftReviewOutputSchema>;
export type RunSummaryOutput = z.infer<typeof runSummaryOutputSchema>;
