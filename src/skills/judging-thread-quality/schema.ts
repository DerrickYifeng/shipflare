import { z } from 'zod';

/**
 * Input: a single thread candidate returned by Grok during a discovery scan,
 * plus the product context the discovery agent already has loaded. The skill
 * does not see the prior xAI conversation — that stays with the agent — and
 * does not see other candidates in the same response. One candidate, one
 * verdict.
 */
export const judgingThreadQualityInputSchema = z.object({
  candidate: z.object({
    title: z.string(),
    body: z.string().default(''),
    author: z.string().default(''),
    url: z.string().optional(),
    platform: z.enum(['x', 'reddit']),
    postedAt: z.string(), // ISO timestamp
  }),
  product: z.object({
    name: z.string(),
    description: z.string(),
    valueProp: z.string().optional(),
  }),
});

export type JudgingThreadQualityInput = z.infer<
  typeof judgingThreadQualityInputSchema
>;

export const MENTION_SIGNALS = [
  'tool_question',
  'debug_problem_fit',
  'competitor_complaint',
  'case_study_request',
  'review_invitation',
  'milestone',
  'vulnerable',
  'grief_or_layoff',
  'political',
  'no_fit',
] as const;
export type MentionSignal = (typeof MENTION_SIGNALS)[number];

/**
 * Output: keep/skip verdict, 0–1 confidence score, one-sentence reason that
 * names the specific product signal (or the gate that blocked), and a tag set
 * the discovery loop can aggregate to refine its next xAI prompt
 * (e.g. "many `competitor_bio` skips → tighten the bio filter").
 *
 * Also carries the product-mention decision (`canMentionProduct` +
 * `mentionSignal`) — folded in from the deprecated `judging-opportunity`
 * skill so a single judging pass produces both the keep verdict and the
 * downstream drafter's product-mention green-light.
 */
export const judgingThreadQualityOutputSchema = z.object({
  keep: z.boolean(),
  score: z.number().min(0).max(1),
  reason: z.string().max(500),
  signals: z.array(z.string()).default([]),
  canMentionProduct: z.boolean().default(false),
  mentionSignal: z.enum(MENTION_SIGNALS).default('no_fit'),
});

export type JudgingThreadQualityOutput = z.infer<
  typeof judgingThreadQualityOutputSchema
>;
