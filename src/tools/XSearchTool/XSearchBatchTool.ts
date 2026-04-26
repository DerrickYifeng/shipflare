import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import {
  type XAIClient,
  SEARCH_TWEETS_BATCH_MAX_QUERIES,
} from '@/lib/xai-client';
import { createLogger } from '@/lib/logger';

const log = createLogger('tool:x_search_batch');

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
    "Batch search X/Twitter for multiple queries in one xAI call. Prefer this over sequential `x_search` when you have 2+ independent queries — it saves prompt duplication, network round-trips, and most of the wall-clock latency. Returns tweets grouped by caller-supplied query id, with each tweet's author enriched with bio + followerCount via a single Grok profile lookup so downstream judges can apply identity-based rules without a second tool call. Results are scoped to original posts (replies/retweets excluded) unless a query explicitly opts in with is:reply or is:retweet. Bio enrichment is best-effort: if Grok cannot resolve a handle, that tweet's `author.bio` is null and `author.followerCount` is null — judges should fall back to text-only reasoning for those.",
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

    // Collect unique author handles across all queries — one Grok profile
    // lookup hydrates every tweet downstream, regardless of which query
    // surfaced it. Costs ~1 server-side `x_search` call (~$0.025) per scan
    // — meaningful but ≤ the per-query search bill we already paid above.
    const handles = Array.from(
      new Set(
        results
          .flatMap((r) => r.tweets.map((t) => t.authorUsername))
          .filter((h): h is string => !!h && h.trim().length > 0),
      ),
    );

    // Best-effort enrichment. Discovery should not crash because a profile
    // lookup timed out — return tweets with `bio: null` and let the judge
    // fall back to text-only reasoning.
    const bioByHandle = new Map<
      string,
      { bio: string | null; followerCount: number | null }
    >();
    if (handles.length > 0) {
      try {
        const bios = await client.fetchUserBios(handles, {
          signal: context.abortSignal,
        });
        for (const b of bios) {
          bioByHandle.set(b.username.toLowerCase().replace(/^@/, ''), {
            bio: b.bio,
            followerCount: b.followerCount,
          });
        }
      } catch (err) {
        log.warn(
          `bio enrichment failed for ${handles.length} handles, returning unenriched results: ${(err as Error).message}`,
        );
      }
    }

    const lookupBio = (
      handle: string,
    ): { bio: string | null; followerCount: number | null } => {
      const key = handle.toLowerCase().replace(/^@/, '');
      return (
        bioByHandle.get(key) ?? { bio: null, followerCount: null }
      );
    };

    return results.map((r) => ({
      queryId: r.queryId,
      tweets: r.tweets.map((t) => {
        const enriched = lookupBio(t.authorUsername);
        return {
          id: t.tweetId,
          url: t.url,
          text: t.text,
          author: {
            handle: t.authorUsername,
            bio: enriched.bio,
            followerCount: enriched.followerCount,
          },
        };
      }),
    }));
  },
});
