import { z } from 'zod';

/**
 * StructuredOutput shape the discovery-agent emits at the end of its run.
 * The coordinator reads `topQueued` to dispatch community-manager on the
 * top-3 without re-querying the threads table.
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
    .max(10),
});

export type DiscoveryAgentOutput = z.infer<typeof discoveryAgentOutputSchema>;
