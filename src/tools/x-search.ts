import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import type { XAIClient } from '@/lib/xai-client';

export const xSearchTool = buildTool({
  name: 'x_search',
  description:
    'Search X/Twitter for tweets matching a query via xAI Grok. Returns tweet ID, URL, author, and text.',
  isConcurrencySafe: true,
  inputSchema: z.object({
    query: z.string().describe('Search query for finding relevant tweets on X'),
    maxResults: z.number().min(1).max(25).default(10),
  }),
  async execute(input, context) {
    const client = context.get<XAIClient>('xaiClient');
    const result = await client.searchTweets(input.query, {
      maxResults: input.maxResults,
      signal: context.abortSignal,
    });

    return result.tweets.map((t) => ({
      id: t.tweetId,
      url: t.url,
      author: t.authorUsername,
      text: t.text,
    }));
  },
});
