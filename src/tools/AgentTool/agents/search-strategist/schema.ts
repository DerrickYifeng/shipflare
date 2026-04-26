// search-strategist StructuredOutput schema.
//
// Strategist runs once per (user, productId, platform). It experiments with
// query candidates against live platform search, evolves them across rounds,
// and emits the winning strategy. The output is persisted to MemoryStore
// under `${platform}-search-strategy` and read by run_discovery_scan on
// every subsequent run — so this schema is the contract between
// "calibration" (expensive, LLM-driven) and "scan" (cheap, deterministic).
//
// `queries` is the only field that goes back into search verbatim;
// everything else is metadata for observability + UI display.

import { z } from 'zod';

export const searchStrategySampleVerdictSchema = z.object({
  url: z.string().min(1),
  queueable: z.boolean(),
  /** Short reason — why this is or isn't a fit. */
  reason: z.string().min(1),
});

export type SearchStrategySampleVerdict = z.infer<
  typeof searchStrategySampleVerdictSchema
>;

export const searchStrategistOutputSchema = z.object({
  /** 2-8 winning queries, ready for x_search_batch / reddit_search. */
  queries: z.array(z.string().min(1)).min(1),
  /** Terms the strategist learned hurt yield (competitor handles, spam
   *  cues bleeding into results). Empty array is fine. */
  negativeTerms: z.array(z.string().min(1)),
  /** 2-4 sentences for the founder + future debugger. References the
   *  dominant signal that drove the final query set. */
  rationale: z.string().min(1),
  /** 0..1; usableQueries / totalQueries on the winning round. */
  observedYield: z.number().min(0).max(1),
  /** How many rounds the strategist used (1, 2, or 3). */
  roundsUsed: z.number().int().min(1).max(3),
  /** 3-5 representative samples for caller transparency. */
  sampleVerdicts: z.array(searchStrategySampleVerdictSchema),
});

export type SearchStrategistOutput = z.infer<typeof searchStrategistOutputSchema>;
