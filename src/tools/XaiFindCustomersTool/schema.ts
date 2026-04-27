import { z } from 'zod';

/**
 * Shape of one tweet returned by xAI's structured-outputs response.
 * Used both as the response_format target and as the input row shape
 * for `persist_queue_threads`.
 *
 * Engagement stats are nullable because xAI may not surface them for
 * every tweet (older posts, deleted accounts, API quirks).
 */
export const tweetCandidateSchema = z.object({
  /** Canonical id — original tweet's id when is_repost=true. */
  external_id: z.string().min(1),
  url: z.string().url(),
  author_username: z.string().min(1),
  author_bio: z.string().nullable(),
  author_followers: z.number().int().nullable(),
  body: z.string(),
  posted_at: z.string(),
  likes_count: z.number().int().nullable(),
  reposts_count: z.number().int().nullable(),
  replies_count: z.number().int().nullable(),
  views_count: z.number().int().nullable(),
  is_repost: z.boolean(),
  /** Reply target's URL — same as `url` when !is_repost; original's URL when is_repost. */
  original_url: z.string().url().nullable(),
  /** Reply target — same as author_username when !is_repost. */
  original_author_username: z.string().nullable(),
  /** Reposter handles when is_repost; null when !is_repost. */
  surfaced_via: z.array(z.string()).nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export type TweetCandidate = z.infer<typeof tweetCandidateSchema>;

export const xaiFindCustomersResponseSchema = z.object({
  tweets: z.array(tweetCandidateSchema).max(50),
  notes: z.string(),
});

export type XaiFindCustomersResponse = z.infer<typeof xaiFindCustomersResponseSchema>;
