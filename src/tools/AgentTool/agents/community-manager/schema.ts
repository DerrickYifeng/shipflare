// Phase E Day 2 — community-manager StructuredOutput schema.
// After running a reply sweep (or a single on-demand draft), the agent
// terminates with { status, counts, notes } so the caller (reply-guy
// discovery worker or coordinator) can attribute draft volume.

import { z } from 'zod';

export const communityManagerOutputSchema = z.object({
  status: z.enum(['completed', 'partial', 'failed']),
  threadsScanned: z.number().int().min(0),
  draftsCreated: z.number().int().min(0),
  draftsSkipped: z.number().int().min(0),
  skippedRationale: z.string(),
  notes: z.string(),
});

export type CommunityManagerOutput = z.infer<typeof communityManagerOutputSchema>;
