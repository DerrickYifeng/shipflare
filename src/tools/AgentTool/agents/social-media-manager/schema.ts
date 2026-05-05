// Plan 3 Task 2 — social-media-manager StructuredOutput schema. Mirrors
// the shape of contentManagerOutputSchema (the predecessor) so callers
// that already consume `{ status, threadsScanned, draftsCreated,
// draftsSkipped, notes }` from content-manager keep working when they
// migrate to the new agent type.

import { z } from 'zod';

export const socialMediaManagerOutputSchema = z.object({
  status: z.enum(['completed', 'partial', 'failed']),
  threadsScanned: z.number().int().min(0).default(0),
  draftsCreated: z.number().int().min(0),
  draftsSkipped: z.number().int().min(0),
  notes: z.string().max(2000),
});

export type SocialMediaManagerOutput = z.infer<typeof socialMediaManagerOutputSchema>;
