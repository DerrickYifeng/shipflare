// draft_reply — persist a reply draft authored by community-manager.
//
// Unlike draft_post (which calls sideQuery to generate the body), this
// tool takes the body as input. The community-manager agent uses its
// own turn budget to draft the reply text before calling the tool —
// this mirrors the original skill-runner pattern and keeps the
// agent's reasoning and the final body tightly coupled.
//
// Side effect: INSERT drafts row with state='pending'. Scoped to
// userId; the tool verifies the referenced thread belongs to the
// same user so an agent can't draft a reply against another founder's
// inbox.

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { drafts, threads } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';

export const DRAFT_REPLY_TOOL_NAME = 'draft_reply';

export const draftReplyInputSchema = z
  .object({
    threadId: z.string().min(1, 'threadId is required'),
    draftBody: z
      .string()
      .min(1, 'draftBody cannot be empty')
      .max(40_000, 'draftBody exceeds the Reddit-post ceiling'),
    confidence: z.number().min(0).max(1),
    whyItWorks: z.string().max(500).optional(),
  })
  .strict();

export type DraftReplyInput = z.infer<typeof draftReplyInputSchema>;

export interface DraftReplyResult {
  draftId: string;
  threadId: string;
  platform: string;
}

export const draftReplyTool: ToolDefinition<DraftReplyInput, DraftReplyResult> =
  buildTool({
    name: DRAFT_REPLY_TOOL_NAME,
    description:
      'Persist a reply draft against an already-discovered thread. Pass ' +
      'the `threadId` (from find_threads), the final `draftBody` text ' +
      'the founder will review, a `confidence` score (0-1), and an ' +
      'optional `whyItWorks` blurb shown in the approval UI. Creates a ' +
      'drafts row with status="pending" — founder approval promotes it ' +
      'to "approved" and the posting worker picks it up from there. ' +
      'Safe to call in parallel for distinct threads.',
    inputSchema: draftReplyInputSchema,
    isConcurrencySafe: true,
    isReadOnly: false,
    async execute(input, ctx): Promise<DraftReplyResult> {
      const { db, userId } = readDomainDeps(ctx);

      // Verify thread ownership before inserting — prevents an agent
      // from drafting against a thread belonging to another user.
      const threadRows = await db
        .select({
          id: threads.id,
          userId: threads.userId,
          platform: threads.platform,
        })
        .from(threads)
        .where(
          and(eq(threads.id, input.threadId), eq(threads.userId, userId)),
        )
        .limit(1);
      const thread = threadRows[0];
      if (!thread) {
        throw new Error(
          `draft_reply: thread ${input.threadId} not found for user ${userId}`,
        );
      }

      const draftId = crypto.randomUUID();
      await db.insert(drafts).values({
        id: draftId,
        userId,
        threadId: input.threadId,
        status: 'pending',
        draftType: 'reply',
        replyBody: input.draftBody,
        confidenceScore: input.confidence,
        whyItWorks: input.whyItWorks ?? null,
        engagementDepth: 0,
      });

      return {
        draftId,
        threadId: input.threadId,
        platform: thread.platform,
      };
    },
  });
