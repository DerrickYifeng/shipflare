import { z } from 'zod';

/**
 * StructuredOutput shape the discovery-agent emits at the end of its run.
 * The coordinator reads `topQueued` to dispatch community-manager without
 * re-querying the threads table. Cap is 20 (was 10) so the coordinator
 * can serve a high `repliesPerDay` strategic-path setting in one batch
 * — kickoff dispatches community-manager on the top-N where N comes from
 * today's content_reply slot's `targetCount` (capped at topQueued.length).
 */
export const discoveryAgentOutputSchema = z.object({
  queued: z.number().int().min(0),
  scanned: z.number().int().min(0),
  scoutNotes: z.string(),
  costUsd: z.number().min(0),
  topQueued: z
    .array(
      z.object({
        externalId: z.string().min(1),
        url: z.string().url(),
        authorUsername: z.string().min(1),
        body: z.string(),
        likesCount: z.number().int().nullable(),
        repostsCount: z.number().int().nullable(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(20),
});

export type DiscoveryAgentOutput = z.infer<typeof discoveryAgentOutputSchema>;
