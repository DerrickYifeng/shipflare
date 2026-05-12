import { enqueuePosting } from '@/lib/queue';
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
  /**
   * Only required for the `enqueuePosting` path (X original_post). Reddit
   * is always-on no-binding so its dispatch is a handoff that never reads
   * channelId; loaders return null in that case.
   */
  channelId: string | null;
}

export type DispatchResult =
  | { kind: 'handoff'; intentUrl: string }
  | { kind: 'queued' };

/**
 * Decide what to do when the user (or auto-approve) approves a draft.
 *
 * Status transition responsibility (caller writes these):
 * - X reply        → handoff via X intent URL.    Caller flips to 'handed_off'.
 * - X post         → queued via posting.ts.       Caller flips to 'approved'.
 * - Reddit post    → handoff via submit URL.      Caller flips to 'handed_off'.
 * - Reddit reply   → handoff via handoff page.    Caller flips to 'handed_off' on dispatch.
 *
 * NOTE: This function only computes the routing decision. The caller is
 * responsible for the matching DB writes.
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

  if (!input.channelId) {
    throw new Error(
      `dispatchApprove: posting path requires channelId (draft ${input.draft.id}, platform ${input.thread.platform})`,
    );
  }

  await enqueuePosting({
    userId: input.draft.userId,
    draftId: input.draft.id,
    channelId: input.channelId,
    mode: 'direct',
  });

  return { kind: 'queued' };
}
