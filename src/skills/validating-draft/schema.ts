import { z } from 'zod';

const slopPatternId = z.enum([
  'diagnostic_from_above',
  'no_first_person',
  'fortune_cookie_closer',
  'colon_aphorism_opener',
  'naked_number_unsourced',
  'em_dash_overuse',
  'binary_not_x_its_y',
  'preamble_opener',
  'banned_vocabulary',
  'triple_grouping',
  'negation_cadence',
  'engagement_bait_filler',
]);

export type SlopPatternId = z.infer<typeof slopPatternId>;

/**
 * Output schema for the validating-draft skill.
 * Adversarial quality check with per-dimension pass/fail plus a 12-pattern
 * slop fingerprint surfacing structural issues regex / heuristics catch.
 */
export const validatingDraftOutputSchema = z.object({
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
  slopFingerprint: z.array(slopPatternId).default([]),
});

export type ValidatingDraftOutput = z.infer<typeof validatingDraftOutputSchema>;

// Backwards-compat alias for code that imported the old name during the
// renaming PR. Remove in the cleanup commit at end of Phase B.
export const reviewingDraftsOutputSchema = validatingDraftOutputSchema;
export type ReviewingDraftsOutput = ValidatingDraftOutput;
