// Phase E Day 1 — x-writer StructuredOutput schema.
// After calling `draft_post`, the agent terminates with
// { status, planItemId, draft_body, notes? }.

import { z } from 'zod';

export const xWriterOutputSchema = z.object({
  status: z.enum(['completed', 'failed']),
  planItemId: z.string().min(1),
  draft_body: z.string(),
  notes: z.string().optional(),
});

export type XWriterOutput = z.infer<typeof xWriterOutputSchema>;
