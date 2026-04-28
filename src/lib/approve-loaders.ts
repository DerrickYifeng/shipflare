import { db } from '@/lib/db';
import { drafts, threads, channels } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
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
      threadId: threads.id,
      threadPlatform: threads.platform,
      threadExternalId: threads.externalId,
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

  const [channelRow] = await db
    .select({ id: channels.id, createdAt: channels.createdAt })
    .from(channels)
    .where(and(eq(channels.userId, userId), eq(channels.platform, row.threadPlatform)))
    .limit(1);

  if (!channelRow) return null;

  const connectedAgeDays = Math.max(
    0,
    Math.floor((Date.now() - channelRow.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
  );

  return {
    draft: {
      id: row.draftId,
      userId: row.draftUserId,
      threadId: row.draftThreadId,
      draftType: row.draftType === 'original_post' ? 'original_post' : 'reply',
      replyBody: row.replyBody,
      planItemId: row.planItemId,
    },
    thread: {
      id: row.threadId,
      platform: row.threadPlatform,
      externalId: row.threadExternalId,
    },
    channelId: channelRow.id,
    connectedAgeDays,
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
