import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const {
  enqueuePosting,
  buildXIntentUrl,
  buildRedditSubmitUrl,
  buildRedditHandoffPageUrl,
} = vi.hoisted(() => {
  const enqueuePosting = vi.fn();
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
    buildXIntentUrl,
    buildRedditSubmitUrl,
    buildRedditHandoffPageUrl,
  };
});

vi.mock('@/lib/queue', () => ({ enqueuePosting }));
vi.mock('@/lib/x-intent-url', () => ({ buildXIntentUrl }));
vi.mock('@/lib/reddit-intent-url', () => ({ buildRedditSubmitUrl }));
vi.mock('@/lib/reddit-handoff-url', () => ({ buildRedditHandoffPageUrl }));

import { dispatchApprove, type DispatchInput } from '../approve-dispatch';

beforeEach(() => {
  enqueuePosting.mockReset();
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

  it('routes X original post to direct queue immediately (no delay)', async () => {
    enqueuePosting.mockResolvedValueOnce(undefined);
    const result = await dispatchApprove({
      ...baseInput,
      draft: { ...baseInput.draft, draftType: 'original_post' },
    });
    expect(result.kind).toBe('queued');
    expect(enqueuePosting).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'd1', mode: 'direct' }),
    );
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
      }),
    ).rejects.toThrow(/postTitle/);
  });

  it('does NOT enqueue for Reddit reply (handoff only)', async () => {
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
    });
    expect(enqueuePosting).not.toHaveBeenCalled();
  });

  it('does NOT enqueue for Reddit post (handoff only)', async () => {
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
    });
    expect(enqueuePosting).not.toHaveBeenCalled();
  });
});
