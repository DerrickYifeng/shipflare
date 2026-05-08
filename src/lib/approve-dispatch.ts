import { enqueuePosting } from '@/lib/queue';
import { computeNextSlot } from '@/lib/posting-pacer';
import { buildXIntentUrl } from '@/lib/x-intent-url';
import { buildRedditSubmitUrl } from '@/lib/reddit-intent-url';
import { buildRedditHandoffPageUrl } from '@/lib/reddit-handoff-url';
import { PLATFORMS } from '@/lib/platform-config';

export interface DispatchInput {
  draft: {
    id: string;
    userId: string;
    threadId: string;
    draftType: 'reply' | 'original_post';
    replyBody: string;
    planItemId: string | null;
    /** Reddit posts only — the subreddit (without r/ prefix). */
    subreddit?: string | null;
    /** Reddit posts only — the title (drafts.postTitle column). */
    postTitle?: string | null;
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
 *
 * Status transition responsibility (caller writes these):
 * - X reply        → handoff via X intent URL.    Caller flips to 'handed_off'.
 * - X post         → queued via posting.ts.       Caller flips to 'approved'.
 * - Reddit post    → handoff via submit URL.      Caller flips to 'handed_off'.
 * - Reddit reply   → handoff via handoff page.    Caller leaves as 'pending'.
 *                                                 Page flips to 'handed_off' on user action.
 *
 * NOTE: This function only computes the routing decision. The caller is
 * responsible for the matching DB writes (see status table above and
 * transition plan_item state).
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

  const isRedditPost =
    input.thread.platform === PLATFORMS.reddit.id &&
    input.draft.draftType === 'original_post';

  if (isRedditPost) {
    if (!input.draft.subreddit) {
      throw new Error(
        `dispatchApprove: Reddit post requires subreddit (draft ${input.draft.id})`,
      );
    }
    if (!input.draft.postTitle) {
      throw new Error(
        `dispatchApprove: Reddit post requires postTitle (draft ${input.draft.id})`,
      );
    }
    return {
      kind: 'handoff',
      intentUrl: buildRedditSubmitUrl({
        subreddit: input.draft.subreddit,
        title: input.draft.postTitle,
        body: input.draft.replyBody,
      }),
    };
  }

  const isRedditReply =
    input.thread.platform === PLATFORMS.reddit.id &&
    input.draft.draftType === 'reply';

  if (isRedditReply) {
    return {
      kind: 'handoff',
      intentUrl: buildRedditHandoffPageUrl(input.draft.id),
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
