import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const {
  enqueuePosting,
  computeNextSlot,
  buildXIntentUrl,
  buildRedditSubmitUrl,
  buildRedditHandoffPageUrl,
} = vi.hoisted(() => {
  const enqueuePosting = vi.fn();
  const computeNextSlot = vi.fn();
  const buildXIntentUrl = vi.fn((args: { text: string; inReplyToTweetId?: string }) => {
    return `https://x.com/intent/post?text=${encodeURIComponent(args.text)}`;
  });
  const buildRedditSubmitUrl = vi.fn(
    (args: { subreddit: string; title: string; body: string }) =>
      `https://www.reddit.com/r/${args.subreddit}/submit?type=text&title=${encodeURIComponent(args.title).replace(/%20/g, '+')}&selftext=${encodeURIComponent(args.body).replace(/%20/g, '+')}`,
  );
  const buildRedditHandoffPageUrl = vi.fn(
    (draftId: string) =>
      `${process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'}/handoff/reddit/${draftId}`,
  );
  return {
    enqueuePosting,
    computeNextSlot,
    buildXIntentUrl,
    buildRedditSubmitUrl,
    buildRedditHandoffPageUrl,
  };
});

vi.mock('@/lib/queue', () => ({ enqueuePosting }));
vi.mock('@/lib/posting-pacer', () => ({ computeNextSlot }));
vi.mock('@/lib/x-intent-url', () => ({ buildXIntentUrl }));
vi.mock('@/lib/reddit-intent-url', () => ({ buildRedditSubmitUrl }));
vi.mock('@/lib/reddit-handoff-url', () => ({ buildRedditHandoffPageUrl }));

import { dispatchApprove, type DispatchInput } from '../approve-dispatch';

beforeEach(() => {
  enqueuePosting.mockReset();
  computeNextSlot.mockReset();
  buildXIntentUrl.mockClear();
  buildRedditSubmitUrl.mockClear();
  buildRedditHandoffPageUrl.mockClear();
});

const baseInput: DispatchInput = {
  draft: {
    id: 'd1',
    userId: 'u1',
    threadId: 't1',
    draftType: 'reply',
    replyBody: 'hello',
    planItemId: 'p1',
  },
  thread: { id: 't1', platform: 'x', externalId: '12345' },
  channelId: 'c1',
  connectedAgeDays: 60,
};

describe('dispatchApprove', () => {
  it('routes X reply to browser handoff (no queue)', async () => {
    const result = await dispatchApprove(baseInput);
    expect(result.kind).toBe('handoff');
    if (result.kind === 'handoff') {
      expect(result.intentUrl).toContain('intent/post');
      expect(result.intentUrl).toContain('hello');
    }
    expect(enqueuePosting).not.toHaveBeenCalled();
    expect(buildXIntentUrl).toHaveBeenCalledWith({
      text: 'hello',
      inReplyToTweetId: '12345',
    });
  });

  it('routes X original post to direct queue with pacer delay', async () => {
    computeNextSlot.mockResolvedValueOnce({
      deferred: false,
      delayMs: 90_000,
      reason: 'spaced',
    });
    const result = await dispatchApprove({
      ...baseInput,
      draft: { ...baseInput.draft, draftType: 'original_post' },
    });
    expect(result.kind).toBe('queued');
    if (result.kind === 'queued') {
      expect(result.delayMs).toBe(90_000);
    }
    expect(enqueuePosting).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'd1', mode: 'direct' }),
      { delayMs: 90_000 },
    );
  });

  it('returns deferred when pacer says over_daily_cap (X post)', async () => {
    computeNextSlot.mockResolvedValueOnce({
      deferred: true,
      reason: 'over_daily_cap',
      delayMs: 4 * 60 * 60 * 1000,
    });
    const result = await dispatchApprove({
      ...baseInput,
      draft: { ...baseInput.draft, draftType: 'original_post' },
    });
    expect(result.kind).toBe('deferred');
    if (result.kind === 'deferred') {
      expect(result.reason).toBe('over_daily_cap');
      expect(result.retryAfterMs).toBe(4 * 60 * 60 * 1000);
    }
    expect(enqueuePosting).not.toHaveBeenCalled();
  });
});

describe('dispatchApprove — Reddit branches', () => {
  const origBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;

  afterEach(() => {
    if (origBaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_BASE_URL = origBaseUrl;
    }
  });

  it('returns handoff with submit URL for Reddit post', async () => {
    const result = await dispatchApprove({
      draft: {
        id: 'd-1',
        userId: 'u-1',
        threadId: 't-1',
        draftType: 'original_post',
        replyBody: 'My selftext body.',
        planItemId: null,
        subreddit: 'SaaS',
        postTitle: 'How I got first users',
      },
      thread: { id: 't-1', platform: 'reddit', externalId: '1abc' },
      channelId: 'ch-1',
      connectedAgeDays: 30,
    });

    expect(result.kind).toBe('handoff');
    if (result.kind !== 'handoff') return;
    expect(result.intentUrl).toContain('reddit.com/r/SaaS/submit');
    expect(result.intentUrl).toContain('selftext=My+selftext+body.');
    expect(buildRedditSubmitUrl).toHaveBeenCalledWith({
      subreddit: 'SaaS',
      title: 'How I got first users',
      body: 'My selftext body.',
    });
  });

  it('returns handoff with handoff-page URL for Reddit reply', async () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://shipflare.io';
    const result = await dispatchApprove({
      draft: {
        id: 'd-2',
        userId: 'u-1',
        threadId: 't-1',
        draftType: 'reply',
        replyBody: 'Tried this myself, it worked.',
        planItemId: null,
      },
      thread: { id: 't-1', platform: 'reddit', externalId: '1abc' },
      channelId: 'ch-1',
      connectedAgeDays: 30,
    });

    expect(result.kind).toBe('handoff');
    if (result.kind !== 'handoff') return;
    expect(result.intentUrl).toBe('https://shipflare.io/handoff/reddit/d-2');
    expect(buildRedditHandoffPageUrl).toHaveBeenCalledWith('d-2');
  });

  it('throws when Reddit post is missing subreddit', async () => {
    await expect(
      dispatchApprove({
        draft: {
          id: 'd-3',
          userId: 'u-1',
          threadId: 't-1',
          draftType: 'original_post',
          replyBody: 'body',
          planItemId: null,
          subreddit: null,
          postTitle: 'title',
        },
        thread: { id: 't-1', platform: 'reddit', externalId: '1' },
        channelId: 'ch-1',
        connectedAgeDays: 30,
      }),
    ).rejects.toThrow(/subreddit/);
  });

  it('throws when Reddit post is missing postTitle', async () => {
    await expect(
      dispatchApprove({
        draft: {
          id: 'd-3b',
          userId: 'u-1',
          threadId: 't-1',
          draftType: 'original_post',
          replyBody: 'body',
          planItemId: null,
          subreddit: 'SaaS',
          postTitle: null,
        },
        thread: { id: 't-1', platform: 'reddit', externalId: '1' },
        channelId: 'ch-1',
        connectedAgeDays: 30,
      }),
    ).rejects.toThrow(/postTitle/);
  });

  it('does NOT call computeNextSlot for Reddit reply (skips pacer)', async () => {
    await dispatchApprove({
      draft: {
        id: 'd-4',
        userId: 'u-1',
        threadId: 't-1',
        draftType: 'reply',
        replyBody: 'x',
        planItemId: null,
      },
      thread: { id: 't-1', platform: 'reddit', externalId: '1' },
      channelId: 'ch-1',
      connectedAgeDays: 30,
    });
    expect(computeNextSlot).not.toHaveBeenCalled();
    expect(enqueuePosting).not.toHaveBeenCalled();
  });

  it('does NOT call computeNextSlot for Reddit post (skips pacer)', async () => {
    await dispatchApprove({
      draft: {
        id: 'd-5',
        userId: 'u-1',
        threadId: 't-1',
        draftType: 'original_post',
        replyBody: 'body',
        planItemId: null,
        subreddit: 'SaaS',
        postTitle: 'Title',
      },
      thread: { id: 't-1', platform: 'reddit', externalId: '1' },
      channelId: 'ch-1',
      connectedAgeDays: 30,
    });
    expect(computeNextSlot).not.toHaveBeenCalled();
    expect(enqueuePosting).not.toHaveBeenCalled();
  });
});
