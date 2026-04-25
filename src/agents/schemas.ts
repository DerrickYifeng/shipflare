import { z } from 'zod';

/**
 * Phase E Day 3 (Task #23) trimmed this file to the schemas that live code
 * still imports. The 18 deleted skills (ab-test-subject, build-launch-runsheet,
 * classify-thread-sentiment, compile-retrospective, deep-analysis,
 * draft-hunter-outreach, draft-launch-day-comment, draft-waitlist-page,
 * extract-milestone-from-commits, fetch-community-hot-posts,
 * fetch-community-rules, generate-interview-questions,
 * generate-launch-asset-brief, identify-top-supporters, draft-single-post,
 * draft-email, send-email, analytics-summarize) also dropped their output
 * schemas and their inferred type aliases. The strategic / tactical planner
 * schemas now live in `src/tools/schemas.ts` and are imported from there.
 */

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
 * Output schema for the community-discovery agent (formerly scout).
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
 * Output schema for the (retired) community-intel skill. Retained here as
 * a type only — `runFullScan` keeps the pipeline's `communityIntel` field
 * shape for downstream consumers even though no skill produces it today.
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
 * Output schema for the x-reply-writer agent — the per-tweet leaf the
 * monitor.ts → reply-hardening pipeline runs against each in-window
 * monitored tweet. Generates a high-value reply with confidence score
 * and chosen archetype, or `strategy: 'skip'` to bail out.
 *
 * (Historically named after the `reply-drafter` Task teammate that was
 * deleted in the agent-cleanup Phase 6 migration. The shape stayed
 * because the programmatic monitor.ts pipeline still consumes it.)
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

export type CommunityDiscoveryOutput = z.infer<typeof communityDiscoveryOutputSchema>;
export type CommunityIntelOutput = z.infer<typeof communityIntelOutputSchema>;
export type PostingOutput = z.infer<typeof postingOutputSchema>;
export type RunSummaryOutput = z.infer<typeof runSummaryOutputSchema>;
export type ReplyDrafterOutput = z.infer<typeof replyDrafterOutputSchema>;
export type EngagementMonitorOutput = z.infer<typeof engagementMonitorOutputSchema>;
export type ProductOpportunityJudgeOutput = z.infer<typeof productOpportunityJudgeOutputSchema>;
export type VoiceExtractorOutput = z.infer<typeof voiceExtractorOutputSchema>;
