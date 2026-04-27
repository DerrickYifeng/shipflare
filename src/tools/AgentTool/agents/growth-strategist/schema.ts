// Phase B Day 4 — growth-strategist StructuredOutput schema.
// Matches spec §8.2: after calling `write_strategic_path`, the agent
// terminates with { status, pathId, summary, notes }.

import { z } from 'zod';

export const growthStrategistOutputSchema = z.object({
  status: z.enum(['completed', 'failed']),
  pathId: z.string().min(1),
  summary: z.string().min(1),
  notes: z.string(),
});

export type GrowthStrategistOutput = z.infer<typeof growthStrategistOutputSchema>;
