// Phase E Day 1 — reddit-writer StructuredOutput schema.
// Mirrors x-writer's shape; both writers terminate with the same
// contract so their callers can treat Task() returns uniformly.

import { z } from 'zod';

export const redditWriterOutputSchema = z.object({
  status: z.enum(['completed', 'failed']),
  planItemId: z.string().min(1),
  draft_body: z.string(),
  notes: z.string().optional(),
});

export type RedditWriterOutput = z.infer<typeof redditWriterOutputSchema>;
