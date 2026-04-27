import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import type { XClient } from '@/lib/x-client';

export const xGetTweetTool = buildTool({
  name: 'x_get_tweet',
  description:
    'Fetch a single tweet by ID with full metadata including text, author, metrics, and timestamps. Requires X Basic tier.',
  isConcurrencySafe: true,
  isReadOnly: true,
  inputSchema: z.object({
    tweetId: z.string().describe('Tweet ID to fetch'),
  }),
  async execute(input, context) {
    const client = context.get<XClient>('xClient');
    const tweet = await client.getTweet(input.tweetId);

    return {
      id: tweet.id,
      text: tweet.text,
      authorUsername: tweet.authorUsername,
      createdAt: tweet.createdAt,
      conversationId: tweet.conversationId,
      metrics: tweet.metrics,
    };
  },
});
