// Phase B Day 4 — coordinator StructuredOutput schema.
// Mirrors the shape enumerated in spec §8.1. runAgent uses this schema to
// synthesize a `StructuredOutput` tool on the coordinator's tool list so its
// terminal turn emits a validated payload the processor persists + returns
// to the caller.

import { z } from 'zod';

export const coordinatorOutputSchema = z.object({
  status: z.enum(['completed', 'partial', 'failed']),
  summary: z.string(),
  teamActivitySummary: z.array(
    z.object({
      memberType: z.string(),
      taskCount: z.number().int().nonnegative(),
      outputSummary: z.string(),
    }),
  ),
  itemsProduced: z.object({
    pathsWritten: z.number().int().nonnegative(),
    planItemsAdded: z.number().int().nonnegative(),
    draftsProduced: z.number().int().nonnegative(),
    messagesExchanged: z.number().int().nonnegative(),
  }),
  errors: z.array(
    z.object({
      member: z.string(),
      error: z.string(),
    }),
  ),
});

export type CoordinatorOutput = z.infer<typeof coordinatorOutputSchema>;
