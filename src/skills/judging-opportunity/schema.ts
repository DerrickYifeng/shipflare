import { z } from 'zod';

export const judgingOpportunityInputSchema = z.object({
  thread: z.object({
    title: z.string(),
    body: z.string().default(''),
    author: z.string(),
    platform: z.enum(['x', 'reddit']),
    community: z.string(),
    upvotes: z.number().int().nonnegative().default(0),
    commentCount: z.number().int().nonnegative().default(0),
    postedAt: z.string(), // ISO timestamp
  }),
  product: z.object({
    name: z.string(),
    description: z.string(),
    valueProp: z.string().optional(),
  }),
  platform: z.enum(['x', 'reddit']),
});

export type JudgingOpportunityInput = z.infer<typeof judgingOpportunityInputSchema>;

export const judgingOpportunityOutputSchema = z.object({
  pass: z.boolean(),
  gateFailed: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  canMentionProduct: z.boolean(),
  signal: z.string().max(120),
  rationale: z.string().max(500),
});

export type JudgingOpportunityOutput = z.infer<typeof judgingOpportunityOutputSchema>;
