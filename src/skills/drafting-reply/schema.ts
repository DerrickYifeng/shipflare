import { z } from 'zod';

const channelEnum = z.enum(['x', 'reddit']);

const voiceCluster = z.enum([
  'terse_shipper',
  'vulnerable_philosopher',
  'daily_vlogger',
  'patient_grinder',
  'contrarian_analyst',
]);

export const draftingReplyInputSchema = z.object({
  thread: z.object({
    title: z.string(),
    body: z.string().default(''),
    author: z.string().optional().default(''),
    /** OP profile bio. Optional — drafter uses to calibrate voice. */
    authorBio: z.string().nullable().optional(),
    /** OP follower count. Optional — drafter uses for tier calibration. */
    authorFollowers: z.number().int().nullable().optional(),
    /** Outer tweet QUOTES this post — body verbatim. Null/absent when not a quote-tweet. */
    quotedText: z.string().nullable().optional(),
    /** Quoted post author handle (no @). Compare to `author` to detect self-quote. */
    quotedAuthor: z.string().nullable().optional(),
    /** Outer tweet is a REPLY to this post — body verbatim. Null/absent when standalone. */
    inReplyToText: z.string().nullable().optional(),
    /** Parent post author handle (no @). */
    inReplyToAuthor: z.string().nullable().optional(),
    platform: channelEnum,
    community: z.string(),
    url: z.string().optional(),
  }),
  product: z.object({
    name: z.string(),
    description: z.string(),
    valueProp: z.string().optional(),
  }),
  channel: channelEnum,
  voice: z.union([voiceCluster, z.string()]).optional(),
  founderVoiceBlock: z.string().optional(),
  canMentionProduct: z.boolean().optional().default(false),
});

export type DraftingReplyInput = z.infer<typeof draftingReplyInputSchema>;

export const draftingReplyOutputSchema = z.object({
  draftBody: z.string().min(1),
  whyItWorks: z.string().max(500),
  confidence: z.number().min(0).max(1),
});

export type DraftingReplyOutput = z.infer<typeof draftingReplyOutputSchema>;
