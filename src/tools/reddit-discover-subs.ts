import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import { RateLimitError } from '@/lib/reddit-client';
import type { RedditClient } from '@/lib/reddit-client';

export const redditDiscoverSubsTool = buildTool({
  name: 'reddit_discover_subs',
  description:
    'Search and discover subreddits relevant to given keywords. Returns subscriber count, description, and activity level.',
  isConcurrencySafe: true,
  isReadOnly: true,
  inputSchema: z.object({
    query: z.string().describe('Search query for finding relevant subreddits'),
    limit: z.number().min(1).max(25).default(10),
  }),
  async execute(input, context) {
    const client = context.get<RedditClient>('redditClient');
    try {
      const results = await client.searchSubreddits(input.query, input.limit);

      return results.map((sub) => ({
        name: sub.name,
        subscribers: sub.subscribers,
        description: sub.description.slice(0, 300),
        activeUsers: sub.activeUsers,
        createdUtc: sub.createdUtc,
      }));
    } catch (error) {
      if (error instanceof RateLimitError) {
        return {
          subreddits: [],
          rateLimited: true,
          message:
            'Reddit API rate limit reached. STOP calling reddit_discover_subs. Return results with communities you have already found.',
        };
      }
      throw error;
    }
  },
});
