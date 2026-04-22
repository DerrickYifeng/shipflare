import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import { RateLimitError } from '@/lib/reddit-client';
import type { RedditClient } from '@/lib/reddit-client';

export const redditSearchTool = buildTool({
  name: 'reddit_search',
  description:
    'Search a subreddit for threads matching a query. Returns title, URL, body (truncated), score, and comment count.',
  isConcurrencySafe: true,
  inputSchema: z.object({
    subreddit: z.string().describe('Subreddit name without r/ prefix'),
    query: z.string().describe('Search query'),
    limit: z.number().min(1).max(25).default(10),
  }),
  async execute(input, context) {
    const client = context.get<RedditClient>('redditClient');
    try {
      const results = await client.searchSubreddit(
        input.subreddit,
        input.query,
        input.limit,
      );

      return results.map((t) => ({
        id: t.id,
        title: t.title,
        url: `https://reddit.com${t.permalink}`,
        body: t.selftext.slice(0, 500),
        author: t.author,
        community: t.subreddit,
        score: t.score,
        commentCount: t.num_comments,
        createdUtc: t.created_utc,
        locked: t.locked,
        archived: t.archived,
      }));
    } catch (error) {
      if (error instanceof RateLimitError) {
        return {
          threads: [],
          rateLimited: true,
          message:
            'Reddit API rate limit reached. STOP calling reddit_search. Proceed to score_threads with the threads you have already collected.',
        };
      }
      throw error;
    }
  },
});
