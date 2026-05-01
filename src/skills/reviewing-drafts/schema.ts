import { z } from 'zod';

/**
 * Output schema for the reviewing-drafts skill.
 * Adversarial quality check with per-dimension pass/fail.
 */
export const reviewingDraftsOutputSchema = z.object({
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

export type ReviewingDraftsOutput = z.infer<typeof reviewingDraftsOutputSchema>;
