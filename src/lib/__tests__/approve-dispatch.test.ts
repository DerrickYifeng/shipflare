import { describe, expect, it, vi, beforeEach } from 'vitest';

const { enqueuePosting, computeNextSlot, buildXIntentUrl } = vi.hoisted(() => {
  const enqueuePosting = vi.fn();
  const computeNextSlot = vi.fn();
  const buildXIntentUrl = vi.fn((args: { text: string; inReplyToTweetId?: string }) => {
    return `https://x.com/intent/post?text=${encodeURIComponent(args.text)}`;
  });
  return { enqueuePosting, computeNextSlot, buildXIntentUrl };
});

vi.mock('@/lib/queue', () => ({ enqueuePosting }));
vi.mock('@/lib/posting-pacer', () => ({ computeNextSlot }));
vi.mock('@/lib/x-intent-url', () => ({ buildXIntentUrl }));

import { dispatchApprove, type DispatchInput } from '../approve-dispatch';

beforeEach(() => {
  enqueuePosting.mockReset();
  computeNextSlot.mockReset();
  buildXIntentUrl.mockClear();
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

  it('routes Reddit reply to direct queue', async () => {
    computeNextSlot.mockResolvedValueOnce({
      deferred: false,
      delayMs: 0,
      reason: 'immediate',
    });
    const result = await dispatchApprove({
      ...baseInput,
      thread: { id: 't1', platform: 'reddit', externalId: 'abc' },
    });
    expect(result.kind).toBe('queued');
    expect(enqueuePosting).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'd1', mode: 'direct' }),
      { delayMs: 0 },
    );
  });

  it('returns deferred when pacer says over_daily_cap', async () => {
    computeNextSlot.mockResolvedValueOnce({
      deferred: true,
      reason: 'over_daily_cap',
      delayMs: 4 * 60 * 60 * 1000,
    });
    const result = await dispatchApprove({
      ...baseInput,
      thread: { id: 't1', platform: 'reddit', externalId: 'abc' },
    });
    expect(result.kind).toBe('deferred');
    if (result.kind === 'deferred') {
      expect(result.reason).toBe('over_daily_cap');
      expect(result.retryAfterMs).toBe(4 * 60 * 60 * 1000);
    }
    expect(enqueuePosting).not.toHaveBeenCalled();
  });
});
