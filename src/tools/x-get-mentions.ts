import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import type { XClient } from '@/lib/x-client';

export const xGetMentionsTool = buildTool({
  name: 'x_get_mentions',
  description:
    'Fetch recent mentions/replies to the authenticated user. Used for post-publish engagement monitoring. Requires X Basic tier.',
  isConcurrencySafe: true,
  isReadOnly: true,
  inputSchema: z.object({
    userId: z.string().describe('Authenticated user ID'),
    sinceId: z
      .string()
      .optional()
      .describe('Only return mentions newer than this tweet ID'),
    maxResults: z
      .number()
      .min(1)
      .max(100)
      .default(10)
      .describe('Number of mentions to return (1-100)'),
  }),
  async execute(input, context) {
    const client = context.get<XClient>('xClient');
    const result = await client.getMentions(input.userId, {
      sinceId: input.sinceId,
      maxResults: input.maxResults,
    });

    return {
      mentions: result.tweets.map((t) => ({
        id: t.id,
        text: t.text,
        authorUsername: t.authorUsername,
        createdAt: t.createdAt,
        conversationId: t.conversationId,
      })),
      newestId: result.newestId,
    };
  },
});
