import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import {
  type XAIClient,
  SEARCH_TWEETS_BATCH_MAX_QUERIES,
} from '@/lib/xai-client';

/**
 * Same filter `XSearchTool` applies — keep the behavior in sync so agents
 * can mix single and batch calls without seeing different result shapes.
 * Duplicated intentionally; extracting a shared helper would be premature
 * while there are only two call sites.
 */
const ORIGINAL_POSTS_ONLY_FILTER = '-is:retweet -is:reply';

const applyFilter = (query: string): string => {
  const normalized = query.trim();
  if (/\bis:reply\b/.test(normalized) || /\bis:retweet\b/.test(normalized)) {
    return normalized;
  }
  return `${normalized} ${ORIGINAL_POSTS_ONLY_FILTER}`;
};

export const xSearchBatchTool = buildTool({
  name: 'x_search_batch',
  description:
    "Batch search X/Twitter for multiple queries in one xAI call. Prefer this over sequential `x_search` when you have 2+ independent queries — it saves prompt duplication, network round-trips, and most of the wall-clock latency. Returns tweets grouped by caller-supplied query id. Results are scoped to original posts (replies/retweets excluded) unless a query explicitly opts in with is:reply or is:retweet.",
  isConcurrencySafe: true,
  inputSchema: z.object({
    queries: z
      .array(
        z.object({
          id: z
            .string()
            .min(1)
            .describe(
              'Caller-supplied id used to correlate results back to the query. Must be unique within the batch.',
            ),
          query: z.string().min(1).describe('X search query'),
          maxResults: z.number().int().min(1).max(25).default(10),
        }),
      )
      .min(1)
      .max(SEARCH_TWEETS_BATCH_MAX_QUERIES)
      .describe(
        `Queries to run in parallel. Max ${SEARCH_TWEETS_BATCH_MAX_QUERIES} per call.`,
      ),
  }),
  async execute(input, context) {
    const client = context.get<XAIClient>('xaiClient');

    const results = await client.searchTweetsBatch(
      input.queries.map((q) => ({
        id: q.id,
        query: applyFilter(q.query),
        maxResults: q.maxResults,
      })),
      { signal: context.abortSignal },
    );

    return results.map((r) => ({
      queryId: r.queryId,
      tweets: r.tweets.map((t) => ({
        id: t.tweetId,
        url: t.url,
        author: t.authorUsername,
        text: t.text,
      })),
    }));
  },
});
