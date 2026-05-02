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

/**
 * Output: keep/skip verdict, 0–1 confidence score, one-sentence reason that
 * names the specific product signal (or the gate that blocked), and a tag set
 * the discovery loop can aggregate to refine its next xAI prompt
 * (e.g. "many `competitor_bio` skips → tighten the bio filter").
 */
export const judgingThreadQualityOutputSchema = z.object({
  keep: z.boolean(),
  score: z.number().min(0).max(1),
  reason: z.string().max(500),
  signals: z.array(z.string()).default([]),
});

export type JudgingThreadQualityOutput = z.infer<
  typeof judgingThreadQualityOutputSchema
>;
