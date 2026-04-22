import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import type { RedditClient } from '@/lib/reddit-client';

export const redditVerifyTool = buildTool({
  name: 'reddit_verify',
  description:
    'Verify a posted comment exists and is visible. Detects shadowbans (comment exists but body is [removed] or author is [deleted]).',
  inputSchema: z.object({
    commentId: z.string().describe('Reddit comment ID (without t1_ prefix)'),
  }),
  async execute(input, context) {
    const client = context.get<RedditClient>('redditClient');
    const result = await client.getComment(input.commentId);
    return {
      exists: result.exists,
      removed: result.removed,
      shadowbanned: result.exists && result.removed,
      visible: result.exists && !result.removed,
    };
  },
});
