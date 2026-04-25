// reply-drafter StructuredOutput schema.
//
// Team-member-level wrapper that drafts replies for a list of queued
// threads using the `draft_single_reply` tool (which runs the full
// opportunity-judge → drafter → AI-slop-validator pipeline internally).
// Distinct from `community-manager`, which writes reply bodies in its own
// LLM turn. One draft per thread; persists drafts rows and enqueues
// automated review.

import { z } from 'zod';

export const replyDrafterOutputSchema = z.object({
  status: z.enum(['completed', 'partial']),
  drafted: z.array(
    z.object({
      threadId: z.string().uuid(),
      draftId: z.string().uuid(),
      body: z.string(),
    }),
  ),
  skipped: z.array(
    z.object({
      threadId: z.string().uuid(),
      reason: z.string(),
    }),
  ),
  notes: z.string(),
});

export type ReplyDrafterOutput = z.infer<typeof replyDrafterOutputSchema>;
