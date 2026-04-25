// discovery-scout StructuredOutput schema.
//
// Scout is invoked per (user, productId, platform). It runs batch searches
// across the caller-supplied sources, then emits ONE verdict per candidate
// thread/post it saw. Callers downstream (discovery-scan processor) write
// only `verdict: 'queue'` rows into the `threads` table; `skip` verdicts
// are logged to the pipeline event stream for observability but not
// persisted.
//
// `confidence` is informational — used for UI ordering and for the
// reviewer gate (low-confidence queues are candidates for reviewer
// override). It is NOT a numeric scoring gate; the queue/skip decision
// belongs to scout's qualitative judgment.

import { z } from 'zod';

export const discoveryScoutVerdictSchema = z.object({
  /** Platform-native id (tweet id / reddit fullname). Stable across runs. */
  externalId: z.string().min(1),
  platform: z.enum(['x', 'reddit']),
  url: z.string().min(1),
  /** Reddit threads have titles; X posts don't — nullable for both. */
  title: z.string().nullable(),
  body: z.string().nullable(),
  author: z.string().nullable(),
  verdict: z.enum(['queue', 'skip']),
  confidence: z.number().min(0).max(1),
  /** 1-2 sentence rationale. Must reference product-specific signal. */
  reason: z.string().min(1),
});

export type DiscoveryScoutVerdict = z.infer<typeof discoveryScoutVerdictSchema>;

export const discoveryScoutOutputSchema = z.object({
  verdicts: z.array(discoveryScoutVerdictSchema),
  /**
   * Free-form notes for the caller (coordinator or processor). Empty
   * verdicts + a non-empty `notes` is a legitimate terminal state when
   * the scout decided the entire scan was noise.
   */
  notes: z.string(),
});

export type DiscoveryScoutOutput = z.infer<typeof discoveryScoutOutputSchema>;
