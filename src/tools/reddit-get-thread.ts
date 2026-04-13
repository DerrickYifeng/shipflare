import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import { RateLimitError } from '@/lib/reddit-client';
import type { RedditClient } from '@/lib/reddit-client';

export const redditGetThreadTool = buildTool({
  name: 'reddit_get_thread',
  description:
    'Get a Reddit thread with its full comment tree. Use for deep analysis of thread context, sentiment, and engagement patterns.',
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultSizeChars: 50_000,
  inputSchema: z.object({
    subreddit: z.string().describe('Subreddit name without r/ prefix'),
    articleId: z.string().describe('Reddit article/thread ID (e.g. "1abc2de")'),
    sort: z
      .enum(['confidence', 'top', 'new'])
      .default('confidence')
      .describe('Comment sort order'),
    limit: z.number().min(1).max(100).default(50),
  }),
  async execute(input, context) {
    const client = context.get<RedditClient>('redditClient');
    try {
      const { thread, comments } = await client.getThread(
        input.subreddit,
        input.articleId,
        input.sort,
        input.limit,
      );

      return {
        id: thread.id,
        title: thread.title,
        body: thread.selftext?.slice(0, 2000) ?? '',
        author: thread.author,
        community: thread.subreddit,
        score: thread.score,
        commentCount: thread.num_comments,
        createdUtc: thread.created_utc,
        locked: thread.locked,
        archived: thread.archived,
        comments: comments.map((c) => ({
          id: c.id,
          author: c.author,
          body: c.body,
          score: c.score,
          createdUtc: c.createdUtc,
          depth: c.depth,
        })),
      };
    } catch (error) {
      if (error instanceof RateLimitError) {
        return {
          rateLimited: true,
          message: 'Reddit API rate limit reached. Skip this thread and continue with what you have.',
        };
      }
      throw error;
    }
  },
});
