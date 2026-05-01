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

export type PostingOutput = z.infer<typeof postingOutputSchema>;
export type EngagementMonitorOutput = z.infer<typeof engagementMonitorOutputSchema>;
