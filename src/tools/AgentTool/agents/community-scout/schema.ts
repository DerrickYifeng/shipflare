// community-scout StructuredOutput schema.
//
// Team-member-level wrapper around the v3 discovery pipeline. Distinct from
// `discovery-scout` (the inner agent invoked by `runDiscoveryV3`). This
// agent is dispatched by the coordinator on `kickoff`, `discovery_cron`,
// and `manual` triggers; it decides which platforms to scan, calls the
// `run_discovery_scan` tool once per platform, and returns the top
// queued threads ranked by confidence so `reply-drafter` can be dispatched
// against them.

import { z } from 'zod';

export const communityScoutOutputSchema = z.object({
  status: z.enum(['completed', 'skipped', 'partial']),
  scannedPlatforms: z.array(
    z.object({
      platform: z.enum(['x', 'reddit']),
      scanned: z.number(),
      queued: z.number(),
      skipped: z.boolean(),
      skipReason: z.string().nullable(),
    }),
  ),
  topQueuedThreads: z
    .array(
      z.object({
        externalId: z.string(),
        platform: z.enum(['x', 'reddit']),
        body: z.string(),
        author: z.string(),
        url: z.string(),
        confidence: z.number(),
      }),
    )
    .max(10),
  notes: z.string(),
});

export type CommunityScoutOutput = z.infer<typeof communityScoutOutputSchema>;
