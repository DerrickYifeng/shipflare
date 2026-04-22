import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import type { XAIClient } from '@/lib/xai-client';

/**
 * Filter operators appended to every x_search query so we only surface
 * original tweets — no replies in someone else's conversation, no retweets.
 *
 * Reply-chain tweets (e.g. target @foo replying to @bar) are poor reply
 * candidates: the audience is small (only the existing thread sees them),
 * and the drafter doesn't have the parent context needed to reply well.
 * Quote tweets pass through (they carry the target's own commentary).
 *
 * Relying on Grok to honor X search operators is best-effort — it's not
 * guaranteed 100%, but it's the only filter available before results
 * come back stripped of `referenced_tweets` metadata.
 */
const ORIGINAL_POSTS_ONLY_FILTER = '-is:retweet -is:reply';

const applyFilter = (query: string): string => {
  const normalized = query.trim();
  // If the caller already explicitly opted into replies or retweets, respect
  // that — they're asking for something specific.
  if (/\bis:reply\b/.test(normalized) || /\bis:retweet\b/.test(normalized)) {
    return normalized;
  }
  return `${normalized} ${ORIGINAL_POSTS_ONLY_FILTER}`;
};

export const xSearchTool = buildTool({
  name: 'x_search',
  description:
    "Search X/Twitter for tweets matching a query via xAI Grok. Returns tweet ID, URL, author, and text. Results are automatically scoped to original posts (replies and retweets are excluded).",
  isConcurrencySafe: true,
  inputSchema: z.object({
    query: z.string().describe('Search query for finding relevant tweets on X'),
    maxResults: z.number().min(1).max(25).default(10),
  }),
  async execute(input, context) {
    const client = context.get<XAIClient>('xaiClient');
    const result = await client.searchTweets(applyFilter(input.query), {
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
