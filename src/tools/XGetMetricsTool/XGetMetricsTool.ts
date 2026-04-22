import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import type { XClient } from '@/lib/x-client';

export const xGetMetricsTool = buildTool({
  name: 'x_get_metrics',
  description:
    'Batch-fetch public metrics (impressions, likes, retweets, bookmarks, etc.) for up to 100 tweet IDs. Requires X Basic tier.',
  isConcurrencySafe: true,
  isReadOnly: true,
  inputSchema: z.object({
    tweetIds: z
      .array(z.string())
      .min(1)
      .max(100)
      .describe('Array of tweet IDs to fetch metrics for (max 100)'),
  }),
  async execute(input, context) {
    const client = context.get<XClient>('xClient');
    const tweets = await client.getTweets(input.tweetIds);

    return tweets.map((t) => ({
      id: t.id,
      metrics: t.metrics ?? {
        retweets: 0,
        replies: 0,
        likes: 0,
        quotes: 0,
        bookmarks: 0,
        impressions: 0,
      },
    }));
  },
});
