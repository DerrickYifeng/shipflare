// draft_post — persist a post body that the post-writer agent has
// already drafted (and validated via `validate_draft`) for one
// `plan_items` row.
//
// This used to call `sideQuery` itself with an inline X / Reddit system
// prompt. That meant the platform reference docs (x-content-guide,
// reddit-content-guide, content-safety) lived on the post-writer agent
// but never reached the actual body generator — `sideQuery` ran in its
// own isolated turn with only the short inline prompt. The result was
// posts that ignored content-type rules, hashtag style, voice, etc.
// We now mirror the reply flow: the agent owns drafting + self-checking
// (with full references in its system prompt + `validate_draft`), and
// this tool's only job is to persist the row.
//
// Side effects:
//   1. Verifies the plan_item is owned by (userId, productId) and has
//      kind='content_post' + a non-null `channel`.
//   2. UPDATEs `plan_items.output.draft_body` (merging onto any prior
//      keys) and flips state to 'drafted'. The `channel` is read from
//      the plan_item row, never overridden by the caller — surfaces
//      mis-routing as a state-machine error rather than a wrong-channel
//      post going out.

import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { planItems } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';

export const DRAFT_POST_TOOL_NAME = 'draft_post';

// Reddit's per-post body cap is 40,000 chars; X is 280 per tweet but a
// thread can run up to 25 tweets joined by `\n\n`. The cap below is the
// loosest of the two — each platform's hard rule is enforced by
// `validate_draft` before the agent calls this tool.
const DRAFT_BODY_MAX = 40_000;

export const draftPostInputSchema = z
  .object({
    planItemId: z.string().min(1, 'planItemId is required'),
    draftBody: z
      .string()
      .min(1, 'draftBody cannot be empty')
      .max(DRAFT_BODY_MAX, 'draftBody exceeds the Reddit-post ceiling'),
    /**
     * Optional rationale shown next to the draft in the founder's review
     * UI. The post-writer fills this with a one-sentence summary of why
     * the angle / hook works for the planned theme.
     */
    whyItWorks: z.string().max(500).optional(),
  })
  .strict();

export type DraftPostInput = z.infer<typeof draftPostInputSchema>;

export interface DraftPostResult {
  planItemId: string;
  draft_body: string;
  channel: string;
}

export const draftPostTool: ToolDefinition<DraftPostInput, DraftPostResult> =
  buildTool({
    name: DRAFT_POST_TOOL_NAME,
    description:
      'Persist a post body the writer has already drafted + validated to ' +
      'a `plan_items` row. Pass the `planItemId` (from the spawn prompt), ' +
      'the final `draftBody` text, and an optional `whyItWorks` blurb. ' +
      'The tool reads `channel` from the plan_item row (never overridden) ' +
      'and merges the body into `plan_items.output.draft_body`, flipping ' +
      'state to `drafted`. Call this AFTER `validate_draft` returns ok — ' +
      'no validation runs here. Safe to call in parallel for distinct ' +
      'plan_item ids.',
    inputSchema: draftPostInputSchema,
    isConcurrencySafe: true,
    isReadOnly: false,
    async execute(input, ctx): Promise<DraftPostResult> {
      const { db, userId, productId } = readDomainDeps(ctx);

      const itemRows = await db
        .select({
          id: planItems.id,
          userId: planItems.userId,
          productId: planItems.productId,
          channel: planItems.channel,
          kind: planItems.kind,
          output: planItems.output,
        })
        .from(planItems)
        .where(eq(planItems.id, input.planItemId))
        .limit(1);
      const item = itemRows[0];
      if (!item) {
        throw new Error(
          `draft_post: plan_item ${input.planItemId} not found`,
        );
      }
      if (item.userId !== userId || item.productId !== productId) {
        throw new Error(
          `draft_post: plan_item ${input.planItemId} is not owned by the ` +
            `current (user, product)`,
        );
      }
      if (item.kind !== 'content_post') {
        throw new Error(
          `draft_post: plan_item ${input.planItemId} has kind="${item.kind}", ` +
            `expected "content_post"`,
        );
      }
      const channel = item.channel;
      if (!channel) {
        throw new Error(
          `draft_post: plan_item ${input.planItemId} has no channel set`,
        );
      }

      // Merge — keeping any prior keys (`confidence`, etc.) — rather than
      // overwriting, so downstream tools can accrete on the same row.
      const prevOutput =
        (item.output as Record<string, unknown> | null | undefined) ?? {};
      const nextOutput: Record<string, unknown> = {
        ...prevOutput,
        draft_body: input.draftBody,
        channel,
      };
      if (input.whyItWorks !== undefined) {
        nextOutput.whyItWorks = input.whyItWorks;
      }

      await db
        .update(planItems)
        .set({
          output: nextOutput,
          state: 'drafted',
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(planItems.id, input.planItemId),
            eq(planItems.userId, userId),
            eq(planItems.productId, productId),
          ),
        );

      return {
        planItemId: input.planItemId,
        draft_body: input.draftBody,
        channel,
      };
    },
  });
