import { z } from 'zod';

const channelEnum = z.enum(['x', 'reddit']);
const phaseEnum = z.enum([
  'foundation',
  'audience',
  'momentum',
  'launch',
  'compound',
  'steady',
]);
const voiceCluster = z.enum([
  'terse_shipper',
  'vulnerable_philosopher',
  'daily_vlogger',
  'patient_grinder',
  'contrarian_analyst',
]);

export const draftingPostInputSchema = z.object({
  planItem: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional().default(''),
    channel: channelEnum,
    scheduledAt: z.string().optional(),
    params: z.record(z.unknown()).optional().default({}),
  }),
  product: z.object({
    name: z.string(),
    description: z.string(),
    valueProp: z.string().optional(),
  }),
  channel: channelEnum,
  phase: phaseEnum.default('foundation'),
  voice: z.union([voiceCluster, z.string()]).optional(),
  founderVoiceBlock: z.string().optional(),
  targetSubreddit: z.string().optional(),
});

export type DraftingPostInput = z.infer<typeof draftingPostInputSchema>;

export const draftingPostOutputSchema = z.object({
  // `draftBody` may be empty when `flagged: true` (subreddit rule conflict).
  // Non-flagged drafts MUST emit a non-empty body; the drafting prompt enforces
  // that in-fork. We don't gate empty bodies at the schema layer because the
  // safe-skip path (Reddit rule conflict) needs to round-trip through Zod.
  draftBody: z.string(),
  whyItWorks: z.string().max(800),
  confidence: z.number().min(0).max(1),
  /** True when the draft was deliberately skipped (e.g., subreddit rule conflict). */
  flagged: z.boolean().optional(),
  /** Human-readable reason, paired with `flagged: true`. Callers may surface this in `/today`. */
  flagReason: z.string().optional(),
});

export type DraftingPostOutput = z.infer<typeof draftingPostOutputSchema>;
