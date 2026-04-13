import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import { RateLimitError } from '@/lib/reddit-client';
import type { RedditClient } from '@/lib/reddit-client';

export const redditHotPostsTool = buildTool({
  name: 'reddit_hot_posts',
  description:
    'Get hot posts from a subreddit to understand trending topics, popular formats, and community engagement patterns.',
  isConcurrencySafe: true,
  isReadOnly: true,
  inputSchema: z.object({
    subreddit: z.string().describe('Subreddit name without r/ prefix'),
    limit: z.number().min(1).max(25).default(10).describe('Number of hot posts to return'),
  }),
  async execute(input, context) {
    const client = context.get<RedditClient>('redditClient');
    try {
      const posts = await client.getHotPosts(input.subreddit, input.limit);
      return { subreddit: input.subreddit, posts };
    } catch (error) {
      if (error instanceof RateLimitError) {
        return {
          subreddit: input.subreddit,
          posts: [],
          rateLimited: true,
          message: 'Reddit API rate limit reached. STOP calling reddit_hot_posts. Use what you have.',
        };
      }
      throw error;
    }
  },
});
