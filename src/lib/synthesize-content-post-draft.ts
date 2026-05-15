/**
 * synthesizeContentPostDraft
 *
 * When the user clicks "Post" on a content_post plan_item in /today,
 * the approve route can't find a linked drafts row because the sweeper
 * only creates drafts for state='planned' rows. This helper bridges the
 * gap: it reads `plan_items.output.draft_body` and synthesises the
 * threads + drafts rows that `loadDispatchInputForDraft` and
 * `dispatchApprove` expect.
 *
 * Returns null if the plan_item has no draft_body in its output — the
 * caller should fall back to the legacy enqueuePlanExecute path.
 *
 * Idempotency note: the synthesised thread uses the planItemId as a
 * stable externalId prefix. If the approve route is called twice (e.g.
 * double-click), the second call will hit the
 * `threads_user_platform_external_uq` constraint. The caller should
 * treat that as a no-op and surface the existing draft instead.
 */

import { z } from 'zod';
import { db } from '@/lib/db';
import { threads, drafts } from '@/lib/db/schema';
import type { OwnedRow } from '@/app/api/plan-item/[id]/_helpers';
import { planItems } from '@/lib/db/schema';
import { and, eq, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Output schema — narrow the jsonb from plan_items.output
// ---------------------------------------------------------------------------

const contentPostOutputSchema = z
  .object({
    draft_body: z.string().min(1),
    // Optional fields that may appear on some rows.
    post_title: z.string().optional(),
    whyItWorks: z.string().optional(),
    confidence_score: z.number().optional(),
  })
  .passthrough(); // allow unknown keys — we only read what we need

type ContentPostOutput = z.infer<typeof contentPostOutputSchema>;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface SynthesisResult {
  draftId: string;
}

export async function synthesizeContentPostDraft(
  planRow: OwnedRow,
  userId: string,
): Promise<SynthesisResult | null> {
  if (planRow.kind !== 'content_post' || !planRow.channel) {
    return null;
  }

  // Fetch the plan_item output + params from the DB (OwnedRow doesn't carry them).
  const [fullRow] = await db
    .select({
      output: planItems.output,
      params: planItems.params,
      title: planItems.title,
    })
    .from(planItems)
    .where(eq(planItems.id, planRow.id))
    .limit(1);

  if (!fullRow) return null;

  // Narrow output — returns null when draft_body is absent or output is null.
  const outputParsed = contentPostOutputSchema.safeParse(fullRow.output);
  if (!outputParsed.success) {
    return null;
  }
  const output: ContentPostOutput = outputParsed.data;

  const platform = planRow.channel; // 'x' | 'reddit'
  const draftBody = output.draft_body;

  // -------------------------------------------------------------------------
  // Resolve Reddit-specific fields from params when needed.
  // -------------------------------------------------------------------------

  let subreddit: string | null = null;
  let postTitle: string | null = null;

  if (platform === 'reddit') {
    // params.subreddit is REQUIRED by AddPlanItemTool for Reddit content_post
    // since the kickoff-research refactor (2026-05-11). Strip any leading
    // `r/` defensively; if it's still null here, AddPlanItem upstream is
    // broken — keep the fallback null so dispatchApprove surfaces a clear
    // error rather than crashing here.
    const rawParams = fullRow.params as Record<string, unknown> | null;
    const rawSubreddit =
      typeof rawParams?.subreddit === 'string' ? rawParams.subreddit : null;
    subreddit = rawSubreddit?.replace(/^r\//, '') ?? null;

    // post_title from output, falling back to the plan_item title.
    postTitle =
      (typeof output.post_title === 'string' ? output.post_title : null) ??
      (typeof fullRow.title === 'string' ? fullRow.title : null);
  }

  // -------------------------------------------------------------------------
  // Insert a placeholder threads row.
  //
  // For content_post there is no "source" thread — we own the original.
  // The externalId is synthesised from the planItemId so it stays unique
  // per (userId, platform) without a real external API id.
  //
  // threads.externalId and threads.url are NOT NULL columns.
  // -------------------------------------------------------------------------

  const syntheticExternalId = `content-post:${planRow.id}`;
  const syntheticUrl = `shipflare://content-post/${planRow.id}`;
  const threadTitle =
    typeof fullRow.title === 'string' && fullRow.title.length > 0
      ? fullRow.title
      : 'Original post';

  // Idempotent insert: re-clicking Post must not violate
  // threads(userId, platform, externalId) UNIQUE. ON CONFLICT DO NOTHING
  // returns no row, so we then SELECT to recover the existing thread id.
  const [insertedThread] = await db
    .insert(threads)
    .values({
      userId,
      platform,
      externalId: syntheticExternalId,
      title: threadTitle,
      url: syntheticUrl,
      body: draftBody,
      community: subreddit ?? undefined,
    })
    .onConflictDoNothing({
      target: [threads.userId, threads.platform, threads.externalId],
    })
    .returning({ id: threads.id });

  let threadRow = insertedThread;
  if (!threadRow) {
    const [existing] = await db
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.userId, userId),
          eq(threads.platform, platform),
          eq(threads.externalId, syntheticExternalId),
        ),
      )
      .limit(1);
    threadRow = existing;
  }

  if (!threadRow) {
    throw new Error(
      `synthesizeContentPostDraft: failed to insert or locate placeholder thread for plan_item ${planRow.id}`,
    );
  }

  // -------------------------------------------------------------------------
  // Insert a drafts row.
  //
  // drafts.confidenceScore is NOT NULL; use output.confidence_score when
  // present, otherwise fall back to 0 (no-confidence placeholder).
  // drafts.replyBody is NOT NULL and holds the post body.
  // -------------------------------------------------------------------------

  const confidenceScore =
    typeof output.confidence_score === 'number' ? output.confidence_score : 0;
  const whyItWorks =
    typeof output.whyItWorks === 'string' ? output.whyItWorks : null;

  // Idempotent insert: the partial unique index `drafts_user_thread_pending_uq`
  // forbids two pending drafts per (userId, threadId). A re-clicked Post (or
  // a fallthrough after `loadDispatchInputForDraft` returned null on first
  // approve) must reuse the existing pending draft rather than crash with
  // a duplicate-key 500. ON CONFLICT DO NOTHING + follow-up SELECT mirrors
  // the threads-insert pattern above.
  const [insertedDraft] = await db
    .insert(drafts)
    .values({
      userId,
      threadId: threadRow.id,
      planItemId: planRow.id,
      draftType: 'original_post',
      replyBody: draftBody,
      postTitle: postTitle ?? undefined,
      status: 'pending',
      confidenceScore,
      whyItWorks: whyItWorks ?? undefined,
    })
    .onConflictDoNothing({
      target: [drafts.userId, drafts.threadId],
      where: sql`"status" = 'pending'`,
    })
    .returning({ id: drafts.id });

  let draftRow = insertedDraft;
  if (!draftRow) {
    const [existing] = await db
      .select({ id: drafts.id })
      .from(drafts)
      .where(
        and(
          eq(drafts.userId, userId),
          eq(drafts.threadId, threadRow.id),
          eq(drafts.status, 'pending'),
        ),
      )
      .limit(1);
    draftRow = existing;
  }

  if (!draftRow) {
    throw new Error(
      `synthesizeContentPostDraft: failed to insert or locate draft for plan_item ${planRow.id}`,
    );
  }

  return { draftId: draftRow.id };
}
