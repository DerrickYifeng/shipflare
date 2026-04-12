import { z } from 'zod';

/**
 * Output schema for the query agent.
 * Maps each subreddit to an array of pain-point search queries.
 */
export const queryOutputSchema = z.object({
  subredditQueries: z.record(z.string(), z.array(z.string())),
});

/**
 * Output schema for the discovery agent.
 * Each thread includes AI-scored relevance and intent dimensions.
 */
export const discoveryOutputSchema = z.object({
  threads: z.array(
    z.object({
      id: z.string(),
      subreddit: z.string(),
      title: z.string(),
      url: z.string(),
      relevance: z.number(),
      intent: z.number(),
      score: z.number().optional(),
      commentCount: z.number().optional(),
      createdUtc: z.number().optional(),
      reason: z.string(),
    }),
  ),
});

export type QueryOutput = z.infer<typeof queryOutputSchema>;
export type DiscoveryOutput = z.infer<typeof discoveryOutputSchema>;
