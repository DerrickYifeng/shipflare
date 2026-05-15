import { db } from '@/lib/db';
import { drafts, threads, channels } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { PLATFORMS } from '@/lib/platform-config';
import type { DispatchInput } from '@/lib/approve-dispatch';

/**
 * Load a draft + its thread + the user's channel for that platform, shaped
 * for `dispatchApprove`. Returns null if any of the joins miss or if the
 * draft is no longer in 'pending' status.
 *
 * Used by both the user-facing approve API and the plan-execute worker —
 * keep these two callers in lockstep so the dispatcher always sees the
 * same input shape.
 */
export async function loadDispatchInputForDraft(
  draftId: string,
  userId: string,
): Promise<DispatchInput | null> {
  const [row] = await db
    .select({
      draftId: drafts.id,
      draftUserId: drafts.userId,
      draftThreadId: drafts.threadId,
      draftType: drafts.draftType,
      replyBody: drafts.replyBody,
      planItemId: drafts.planItemId,
      postTitle: drafts.postTitle,
      threadId: threads.id,
      threadPlatform: threads.platform,
      threadExternalId: threads.externalId,
      threadCommunity: threads.community,
    })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.userId, userId),
        eq(drafts.status, 'pending'),
      ),
    )
    .limit(1);

  if (!row) return null;

  // Reddit is always-on no-binding — no `channels` row exists, and
  // dispatchApprove never reads channelId for Reddit (handoff path). For
  // every other platform the row is required so the X-post `enqueuePosting`
  // call has a channel to bind to.
  let channelId: string | null = null;
  if (row.threadPlatform !== PLATFORMS.reddit.id) {
    const [channelRow] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.userId, userId), eq(channels.platform, row.threadPlatform)))
      .limit(1);

    if (!channelRow) return null;
    channelId = channelRow.id;
  }

  return {
    draft: {
      id: row.draftId,
      userId: row.draftUserId,
      threadId: row.draftThreadId,
      draftType: row.draftType === 'original_post' ? 'original_post' : 'reply',
      replyBody: row.replyBody,
      planItemId: row.planItemId,
      postTitle: row.postTitle,
      subreddit: row.threadCommunity,
    },
    thread: {
      id: row.threadId,
      platform: row.threadPlatform,
      externalId: row.threadExternalId,
    },
    channelId,
  };
}

/**
 * Find the draft linked to a plan_item via drafts.planItemId. Filters to
 * status='pending' so already-terminal drafts return null.
 */
export async function findDraftIdForPlanItem(
  planItemId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.planItemId, planItemId), eq(drafts.status, 'pending')))
    .limit(1);
  return row?.id ?? null;
}
