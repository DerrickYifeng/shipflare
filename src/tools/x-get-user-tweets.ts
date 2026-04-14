import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import type { XClient } from '@/lib/x-client';

export const xGetUserTweetsTool = buildTool({
  name: 'x_get_user_tweets',
  description:
    'Fetch recent tweets from a specific X user by their user ID. Returns tweet text, metrics, and timestamps. Requires X Basic tier.',
  isConcurrencySafe: true,
  isReadOnly: true,
  inputSchema: z.object({
    userId: z.string().describe('X user ID (numeric string)'),
    sinceId: z
      .string()
      .optional()
      .describe('Only return tweets newer than this tweet ID'),
    maxResults: z
      .number()
      .min(1)
      .max(100)
      .default(10)
      .describe('Number of tweets to return (1-100)'),
  }),
  async execute(input, context) {
    const client = context.get<XClient>('xClient');
    const result = await client.getUserTweets(input.userId, {
      sinceId: input.sinceId,
      maxResults: input.maxResults,
    });

    return {
      tweets: result.tweets.map((t) => ({
        id: t.id,
        text: t.text,
        authorUsername: t.authorUsername,
        createdAt: t.createdAt,
        metrics: t.metrics,
      })),
      newestId: result.newestId,
    };
  },
});
