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
    /**
     * Reddit-only — the subreddit name (no `r/` prefix). Absent for X
     * threads because X has no equivalent concept; including a placeholder
     * value here invited the drafter to hand it to `get_subreddit_rules`,
     * which then 404'd against Reddit. The skill body's
     * "Reddit-specific drafting" section is the only place that may
     * reference this field.
     */
    community: z.string().min(1).nullable().optional(),
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
  // `draftBody` may be empty when `flagged: true` (subreddit rule conflict).
  // Non-flagged drafts MUST emit a non-empty body; the drafting prompt enforces
  // that in-fork. We don't gate empty bodies at the schema layer because the
  // safe-skip path (Reddit rule conflict) needs to round-trip through Zod.
  draftBody: z.string(),
  whyItWorks: z.string().max(500),
  confidence: z.number().min(0).max(1),
  /** True when the draft was deliberately skipped (e.g., subreddit rule conflict). */
  flagged: z.boolean().optional(),
  /** Human-readable reason, paired with `flagged: true`. Callers may surface this in `/today`. */
  flagReason: z.string().optional(),
});

export type DraftingReplyOutput = z.infer<typeof draftingReplyOutputSchema>;
