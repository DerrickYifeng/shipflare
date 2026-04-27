// post-writer StructuredOutput schema.
//
// Single shape for X and Reddit drafts; the platform comes in via the
// plan_item's `channel` column, not via the writer's terminal payload.
// The shape mirrors the original x-writer / reddit-writer schemas so
// callers that already read `{ status, planItemId, draft_body, notes? }`
// keep working.

import { z } from 'zod';

export const postWriterOutputSchema = z.object({
  status: z.enum(['completed', 'failed']),
  planItemId: z.string().min(1),
  draft_body: z.string(),
  notes: z.string().optional(),
});

export type PostWriterOutput = z.infer<typeof postWriterOutputSchema>;
