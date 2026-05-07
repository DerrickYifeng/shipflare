// JSON Schemas for the xAI Responses API `response_format.json_schema`
// envelope, in xAI's strict shape:
//   - every property in `required`
//   - optional/nullable fields use `["string", "null"]` unions
//   - `additionalProperties: false` on every object
//   - no `$schema`, `$id`, `$ref`
//
// X schema mirrors `xaiFindCustomersResponseSchema`'s tweet-row fields
// (the existing X tool derives an equivalent schema from Zod via
// `toXaiJsonSchema`; this is the static/literal form FindThreadsViaXaiTool
// will pass directly to xAI). maxItems: 50.
//
// Reddit schema is new — fields cover thread metadata, engagement
// (score, num_comments, num_crossposts), and link/lock/over_18 flags
// the moderation pipeline needs. maxItems: 20 — Reddit signal is
// noisier than X so we tighten the cap.

import { z } from 'zod';

/**
 * One Reddit thread row returned by xAI Grok web_search (reddit.com).
 *
 * Mirrors `REDDIT_THREAD_SEARCH_SCHEMA` below — the JSON schema is the
 * one xAI sees for structured-output validation; this Zod schema is
 * what we re-validate the parsed JSON against on our side. Keeping
 * the two in sync is intentional duplication: xAI's strict mode
 * accepts only static JSON schema, but our caller wants Zod's
 * `safeParse` ergonomics.
 *
 * `external_id` is the reddit base-36 thread ID (the segment after
 * `/comments/` in the URL) so persist-time dedup keys remain stable.
 */
export const redditThreadCandidateSchema = z.object({
  external_id: z.string().min(1),
  url: z.string().url(),
  subreddit: z.string().min(1),
  author_username: z.string().min(1),
  author_karma: z.number().int().nullable(),
  title: z.string(),
  body: z.string(),
  posted_at: z.string(),
  score: z.number().int(),
  num_comments: z.number().int(),
  num_crossposts: z.number().int(),
  is_self: z.boolean(),
  link_url: z.string().nullable(),
  over_18: z.boolean(),
  locked: z.boolean(),
  archived: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export type RedditThreadCandidate = z.infer<typeof redditThreadCandidateSchema>;

/**
 * Outer envelope for the Reddit discovery response. Mirrors the
 * shape `REDDIT_THREAD_SEARCH_SCHEMA` declares: `{ threads, notes }`.
 */
export const redditThreadSearchResponseSchema = z.object({
  threads: z.array(redditThreadCandidateSchema).max(20),
  notes: z.string(),
});

export type RedditThreadSearchResponse = z.infer<
  typeof redditThreadSearchResponseSchema
>;

export const X_TWEET_SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tweets', 'notes'],
  properties: {
    tweets: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'external_id',
          'url',
          'author_username',
          'author_bio',
          'author_followers',
          'body',
          'posted_at',
          'likes_count',
          'reposts_count',
          'replies_count',
          'views_count',
          'is_repost',
          'original_url',
          'original_author_username',
          'surfaced_via',
          'quoted_text',
          'quoted_author',
          'in_reply_to_text',
          'in_reply_to_author',
          'confidence',
          'reason',
        ],
        properties: {
          external_id: { type: 'string' },
          url: { type: 'string' },
          author_username: { type: 'string' },
          author_bio: { type: ['string', 'null'] },
          author_followers: { type: ['integer', 'null'] },
          body: { type: 'string' },
          posted_at: { type: 'string' },
          likes_count: { type: ['integer', 'null'] },
          reposts_count: { type: ['integer', 'null'] },
          replies_count: { type: ['integer', 'null'] },
          views_count: { type: ['integer', 'null'] },
          is_repost: { type: 'boolean' },
          original_url: { type: ['string', 'null'] },
          original_author_username: { type: ['string', 'null'] },
          surfaced_via: { type: ['string', 'null'] },
          quoted_text: { type: ['string', 'null'] },
          quoted_author: { type: ['string', 'null'] },
          in_reply_to_text: { type: ['string', 'null'] },
          in_reply_to_author: { type: ['string', 'null'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
} as const;

export const REDDIT_THREAD_SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['threads', 'notes'],
  properties: {
    threads: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'external_id',
          'url',
          'subreddit',
          'author_username',
          'author_karma',
          'title',
          'body',
          'posted_at',
          'score',
          'num_comments',
          'num_crossposts',
          'is_self',
          'link_url',
          'over_18',
          'locked',
          'archived',
          'confidence',
          'reason',
        ],
        properties: {
          external_id: { type: 'string' },
          url: { type: 'string' },
          subreddit: { type: 'string' },
          author_username: { type: 'string' },
          author_karma: { type: ['integer', 'null'] },
          title: { type: 'string' },
          body: { type: 'string' },
          posted_at: { type: 'string' },
          score: { type: 'integer' },
          num_comments: { type: 'integer' },
          num_crossposts: { type: 'integer' },
          is_self: { type: 'boolean' },
          link_url: { type: ['string', 'null'] },
          over_18: { type: 'boolean' },
          locked: { type: 'boolean' },
          archived: { type: 'boolean' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
} as const;
