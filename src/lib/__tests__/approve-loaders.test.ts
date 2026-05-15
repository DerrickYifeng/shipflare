/**
 * Regression tests for loadDispatchInputForDraft.
 *
 * Reddit is always-on no-binding (no `channels` row exists). The loader must
 * still return a DispatchInput for Reddit drafts; before this fix it returned
 * null, which made the /today approve route fall through to
 * synthesizeContentPostDraft and crash with a duplicate-key violation on
 * `drafts_user_thread_pending_uq`.
 *
 * X (and any future platform that requires a channel) must still return null
 * when the channels row is missing, so the X-post enqueuePosting path can't
 * be reached without a bound channel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbSelectMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: () => dbSelectMock(),
          }),
        }),
        where: () => ({
          limit: () => dbSelectMock(),
        }),
      }),
    }),
  },
}));

import { loadDispatchInputForDraft } from '../approve-loaders';

beforeEach(() => {
  dbSelectMock.mockReset();
});

const baseRow = {
  draftId: 'd-1',
  draftUserId: 'u-1',
  draftThreadId: 't-1',
  draftType: 'original_post',
  replyBody: 'hello',
  planItemId: 'pi-1',
  postTitle: 'Hello world',
  threadId: 't-1',
  threadExternalId: 'content-post:pi-1',
  threadCommunity: 'SaaS',
};

describe('loadDispatchInputForDraft', () => {
  it('returns DispatchInput for Reddit without looking up a channels row', async () => {
    // Only one DB call: the drafts/threads join. NO channels select.
    dbSelectMock.mockResolvedValueOnce([
      { ...baseRow, threadPlatform: 'reddit' },
    ]);

    const result = await loadDispatchInputForDraft('d-1', 'u-1');

    expect(result).not.toBeNull();
    expect(result?.channelId).toBeNull();
    expect(result?.thread.platform).toBe('reddit');
    expect(result?.draft.subreddit).toBe('SaaS');
    // Only ONE select fired (no channels lookup).
    expect(dbSelectMock).toHaveBeenCalledTimes(1);
  });

  it('returns null for X when no channels row exists', async () => {
    // First select: drafts join threads returns the row.
    dbSelectMock.mockResolvedValueOnce([
      { ...baseRow, threadPlatform: 'x' },
    ]);
    // Second select: channels lookup returns empty.
    dbSelectMock.mockResolvedValueOnce([]);

    const result = await loadDispatchInputForDraft('d-1', 'u-1');

    expect(result).toBeNull();
    expect(dbSelectMock).toHaveBeenCalledTimes(2);
  });

  it('returns DispatchInput with channelId for X when channels row exists', async () => {
    dbSelectMock.mockResolvedValueOnce([
      { ...baseRow, threadPlatform: 'x' },
    ]);
    dbSelectMock.mockResolvedValueOnce([{ id: 'ch-1' }]);

    const result = await loadDispatchInputForDraft('d-1', 'u-1');

    expect(result).not.toBeNull();
    expect(result?.channelId).toBe('ch-1');
    expect(result?.thread.platform).toBe('x');
  });

  it('returns null when the drafts/threads join misses', async () => {
    dbSelectMock.mockResolvedValueOnce([]);
    const result = await loadDispatchInputForDraft('d-1', 'u-1');
    expect(result).toBeNull();
    expect(dbSelectMock).toHaveBeenCalledTimes(1);
  });
});
