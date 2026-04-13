import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import type { XClient } from '@/lib/x-client';

export const xPostTool = buildTool({
  name: 'x_post',
  description:
    'Post a tweet or reply to an existing tweet on X. Text must be 280 characters or less.',
  inputSchema: z.object({
    text: z
      .string()
      .max(280)
      .describe('Tweet text (max 280 characters)'),
    replyToTweetId: z
      .string()
      .optional()
      .describe('Tweet ID to reply to. If omitted, posts a new tweet.'),
  }),
  async execute(input, context) {
    const client = context.get<XClient>('xClient');

    if (input.replyToTweetId) {
      const result = await client.replyToTweet(
        input.replyToTweetId,
        input.text,
      );
      return {
        tweetId: result.tweetId,
        url: result.url,
        type: 'reply',
      };
    }

    const result = await client.postTweet(input.text);
    return {
      tweetId: result.tweetId,
      url: result.url,
      type: 'tweet',
    };
  },
});
