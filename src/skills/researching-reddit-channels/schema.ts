// Schemas for the `researching-reddit-channels` skill.
//
// The skill takes a product description + optional ICP signal and returns
// N candidate subreddits with ICP-fit scoring. The worker (Task 4) calls
// this skill via runForkSkill, then post-processes: member-count refresh
// via /about.json, top-K selection, persistence to product_reddit_channels.
//
// Contract:
//   Input  → product fields + optional icp + candidateCount (3..12, default 6)
//   Output → candidates[] (subreddit, rulesSummary, fitRationale, fitScore,
//            nullable memberCountApprox) + costUsd

import { z } from 'zod';

export const researchingRedditChannelsInputSchema = z.object({
  product: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    valueProp: z.string().optional(),
  }),
  /** ICP signal — free text describing who the audience is. */
  icp: z.string().optional(),
  /** N candidates to surface before top-K selection. Default 6. */
  candidateCount: z.number().int().min(3).max(12).default(6),
});

export type ResearchingRedditChannelsInput = z.infer<
  typeof researchingRedditChannelsInputSchema
>;

const candidateSchema = z.object({
  /** Without `r/` prefix. Encodes Reddit's actual subreddit naming
   *  rules: 3..21 chars, [A-Za-z0-9_]+ — catches xAI hallucinations
   *  like a stray `r/` prefix or punctuation at parse time. */
  subreddit: z
    .string()
    .min(3)
    .max(21)
    .regex(/^[A-Za-z0-9_]+$/, 'Subreddit must match /^[A-Za-z0-9_]+$/'),
  /** Member count as reported by xAI from the public subreddit page.
   *  `null` when xAI couldn't read the exact figure. The worker
   *  (Task 4) overwrites this with a /about.json fetch either way. */
  memberCountApprox: z.number().int().nullable().optional(),
  /** One-paragraph summary of the rules that matter (self-promo, AI,
   *  no-founders, etc.). Empty string if none relevant. */
  rulesSummary: z.string(),
  /** Why this subreddit is or isn't a fit. One paragraph max. */
  fitRationale: z.string(),
  /** 0..1. 1 = ideal ICP match. */
  fitScore: z.number().min(0).max(1),
});

export const researchingRedditChannelsOutputSchema = z.object({
  candidates: z.array(candidateSchema).min(0).max(12),
  costUsd: z.number().min(0).default(0),
});

export type ResearchingRedditChannelsOutput = z.infer<
  typeof researchingRedditChannelsOutputSchema
>;

export type RedditChannelCandidate = z.infer<typeof candidateSchema>;
