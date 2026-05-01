import { enqueuePosting } from '@/lib/queue';
import { computeNextSlot } from '@/lib/posting-pacer';
import { buildXIntentUrl } from '@/lib/x-intent-url';
import { PLATFORMS } from '@/lib/platform-config';

export interface DispatchInput {
  draft: {
    id: string;
    userId: string;
    threadId: string;
    draftType: 'reply' | 'original_post';
    replyBody: string;
    planItemId: string | null;
  };
  thread: {
    id: string;
    platform: string;
    externalId: string | null;
  };
  channelId: string;
  /** Days since the user connected this channel. Tier input for the pacer. */
  connectedAgeDays: number;
}

export type DispatchResult =
  | { kind: 'handoff'; intentUrl: string }
  | { kind: 'queued'; delayMs: number }
  | {
      kind: 'deferred';
      reason: 'over_daily_cap' | 'no_pacer_config';
      retryAfterMs: number;
    };

/**
 * Decide what to do when the user (or auto-approve) approves a draft.
 * - X replies → browser handoff via intent URL (TOS-compliant; X's Feb 2026
 *   API restriction blocks programmatic replies on non-Enterprise tiers).
 * - X original posts + Reddit anything → direct API call via the posting
 *   processor, paced by `computeNextSlot`.
 *
 * NOTE: This function only computes the routing decision. The caller is
 * responsible for the matching DB writes (set draft.status to 'handed_off'
 * for handoff, 'approved' for queued; transition plan_item state).
 */
export async function dispatchApprove(
  input: DispatchInput,
): Promise<DispatchResult> {
  const isXReply =
    input.thread.platform === PLATFORMS.x.id &&
    input.draft.draftType === 'reply';

  if (isXReply) {
    if (!input.thread.externalId) {
      throw new Error(
        `dispatchApprove: X reply requires thread.externalId (draft ${input.draft.id})`,
      );
    }
    return {
      kind: 'handoff',
      intentUrl: buildXIntentUrl({
        text: input.draft.replyBody,
        inReplyToTweetId: input.thread.externalId,
      }),
    };
  }

  const slot = await computeNextSlot({
    userId: input.draft.userId,
    platform: input.thread.platform,
    kind: input.draft.draftType === 'reply' ? 'reply' : 'post',
    connectedAgeDays: input.connectedAgeDays,
  });

  if (slot.deferred) {
    return {
      kind: 'deferred',
      reason: slot.reason,
      retryAfterMs: slot.delayMs,
    };
  }

  await enqueuePosting(
    {
      userId: input.draft.userId,
      draftId: input.draft.id,
      channelId: input.channelId,
      mode: 'direct',
    },
    { delayMs: slot.delayMs },
  );

  return { kind: 'queued', delayMs: slot.delayMs };
}
