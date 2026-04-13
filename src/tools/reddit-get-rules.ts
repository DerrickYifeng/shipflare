import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import { RateLimitError } from '@/lib/reddit-client';
import type { RedditClient } from '@/lib/reddit-client';

export const redditGetRulesTool = buildTool({
  name: 'reddit_get_rules',
  description:
    'Get a subreddit\'s rules including self-promotion policies. Returns an array of rules with title, description, and kind.',
  isConcurrencySafe: true,
  isReadOnly: true,
  inputSchema: z.object({
    subreddit: z.string().describe('Subreddit name without r/ prefix'),
  }),
  async execute(input, context) {
    const client = context.get<RedditClient>('redditClient');
    try {
      const rules = await client.getSubredditRules(input.subreddit);
      return { subreddit: input.subreddit, rules };
    } catch (error) {
      if (error instanceof RateLimitError) {
        return {
          subreddit: input.subreddit,
          rules: [],
          rateLimited: true,
          message: 'Reddit API rate limit reached. STOP calling reddit_get_rules. Use what you have.',
        };
      }
      throw error;
    }
  },
});
