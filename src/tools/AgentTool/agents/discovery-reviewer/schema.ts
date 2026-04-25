// discovery-reviewer StructuredOutput schema.
//
// Reviewer is an INDEPENDENT adversarial judge — it does NOT see scout's
// verdicts. Its job: look at a batch of candidate threads and emit one
// verdict per thread, biased toward caution (default skip, require
// specific product-relevant evidence before queuing).
//
// The caller (discovery-scan during cold/warm phases, or the coordinator
// on demand) diffs these judgments against whatever else it's comparing.
// Disagreement → memory log. Agreement → no-op.

import { z } from 'zod';

export const discoveryReviewerJudgmentSchema = z.object({
  externalId: z.string().min(1),
  verdict: z.enum(['queue', 'skip']),
  /** 0..1 — see reviewer-guidelines for calibration. */
  confidence: z.number().min(0).max(1),
  /** 1-2 sentences naming the specific product signal that drove the call. */
  reasoning: z.string().min(1),
});

export type DiscoveryReviewerJudgment = z.infer<
  typeof discoveryReviewerJudgmentSchema
>;

export const discoveryReviewerOutputSchema = z.object({
  judgments: z.array(discoveryReviewerJudgmentSchema),
  /** Sweep-level observations for the caller. */
  notes: z.string(),
});

export type DiscoveryReviewerOutput = z.infer<
  typeof discoveryReviewerOutputSchema
>;
