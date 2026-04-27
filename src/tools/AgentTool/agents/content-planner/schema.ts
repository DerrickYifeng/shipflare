// Phase B Day 4 — content-planner StructuredOutput schema.
// Matches spec §8.3: after calling add_plan_item per scheduled item,
// the agent terminates with a weekly summary.

import { z } from 'zod';

export const contentPlannerOutputSchema = z.object({
  status: z.enum(['completed', 'partial']),
  weekStart: z.string().min(1), // ISO Monday 00:00 UTC
  itemsAdded: z.number().int().nonnegative(),
  itemsByChannel: z.object({
    x: z.number().int().nonnegative().optional(),
    reddit: z.number().int().nonnegative().optional(),
    email: z.number().int().nonnegative().optional(),
    none: z.number().int().nonnegative().optional(),
  }),
  stalledCarriedOver: z.number().int().nonnegative(),
  notes: z.string(),
});

export type ContentPlannerOutput = z.infer<typeof contentPlannerOutputSchema>;
