import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import type { RedditClient } from '@/lib/reddit-client';

export const redditSubmitPostTool = buildTool({
  name: 'reddit_submit_post',
  description:
    'Submit a new self-post (text thread) to a subreddit. Returns the post ID and URL. Requires OAuth authentication.',
  isConcurrencySafe: false,
  inputSchema: z.object({
    subreddit: z.string().describe('Subreddit name without r/ prefix'),
    title: z.string().describe('Post title'),
    text: z.string().describe('Post body text (markdown)'),
  }),
  async execute(input, context) {
    const client = context.get<RedditClient>('redditClient');
    const result = await client.submitPost(
      input.subreddit,
      input.title,
      input.text,
    );
    return {
      postId: result.id,
      url: result.url,
    };
  },
});
