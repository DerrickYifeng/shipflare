import { z } from 'zod';

/**
 * Output schema for the posting-to-platform skill.
 * Reports whether a draft was successfully posted and verified.
 */
export const postingToPlatformOutputSchema = z.object({
  success: z.boolean(),
  draftType: z.enum(['reply', 'original_post']).optional(),
  commentId: z.string().nullable(),
  postId: z.string().nullable().optional(),
  permalink: z.string().nullable(),
  url: z.string().nullable().optional(),
  verified: z.boolean(),
  shadowbanned: z.boolean(),
  error: z.string().optional(),
});

export type PostingToPlatformOutput = z.infer<typeof postingToPlatformOutputSchema>;
