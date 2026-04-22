import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import type { XClient } from '@/lib/x-client';

export const xThreadPostTool = buildTool({
  name: 'x_thread_post',
  description:
    'Post a multi-tweet thread on X. Each tweet must be 280 characters or less. Tweets are chained as replies to form a thread.',
  inputSchema: z.object({
    tweets: z
      .array(z.string().max(280))
      .min(1)
      .max(25)
      .describe('Array of tweet texts forming the thread (each max 280 chars)'),
  }),
  async execute(input, context) {
    const client = context.get<XClient>('xClient');
    const results = await client.postThread(input.tweets);

    return {
      thread: results.map((r, i) => ({
        position: i + 1,
        tweetId: r.tweetId,
        url: r.url,
      })),
      threadLength: results.length,
    };
  },
});
