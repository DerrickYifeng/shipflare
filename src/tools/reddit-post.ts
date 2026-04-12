import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import type { RedditClient } from '@/lib/reddit-client';

export const redditPostTool = buildTool({
  name: 'reddit_post',
  description:
    'Post a comment on a Reddit thread. Returns the comment ID and permalink.',
  inputSchema: z.object({
    threadFullname: z
      .string()
      .describe('Reddit fullname of the thread (e.g., t3_abc123)'),
    text: z.string().describe('Comment text to post'),
  }),
  async execute(input, context) {
    const client = context.get<RedditClient>('redditClient');
    const result = await client.postComment(
      input.threadFullname,
      input.text,
    );
    return {
      commentId: result.id,
      permalink: result.permalink,
    };
  },
});
