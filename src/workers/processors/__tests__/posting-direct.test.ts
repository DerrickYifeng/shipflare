import { describe, expect, it, vi, beforeEach } from 'vitest';
import { XClient } from '@/lib/x-client';
import { RedditClient } from '@/lib/reddit-client';
import { postViaDirectMode } from '../posting';

describe('postViaDirectMode', () => {
  it('calls postTweet for X original_post', async () => {
    const postTweet = vi.fn().mockResolvedValue({ tweetId: '999', url: 'https://x.com/u/status/999' });
    const replyToTweet = vi.fn();
    const client = Object.create(XClient.prototype) as XClient;
    Object.assign(client, { postTweet, replyToTweet });

    const result = await postViaDirectMode({
      platform: 'x',
      draftType: 'original_post',
      draftText: 'hi world',
      threadExternalId: null,
      threadCommunity: 'topic',
      postTitle: null,
      client,
    });
    expect(postTweet).toHaveBeenCalledWith('hi world');
    expect(result.success).toBe(true);
    expect(result.externalId).toBe('999');
    expect(result.externalUrl).toBe('https://x.com/u/status/999');
  });

  it('calls replyToTweet for X reply', async () => {
    const postTweet = vi.fn();
    const replyToTweet = vi.fn().mockResolvedValue({ tweetId: '777', url: 'https://x.com/u/status/777' });
    const client = Object.create(XClient.prototype) as XClient;
    Object.assign(client, { postTweet, replyToTweet });

    const result = await postViaDirectMode({
      platform: 'x',
      draftType: 'reply',
      draftText: 'reply body',
      threadExternalId: '111',
      threadCommunity: 'topic',
      postTitle: null,
      client,
    });
    expect(replyToTweet).toHaveBeenCalledWith('111', 'reply body');
    expect(result.success).toBe(true);
    expect(result.externalId).toBe('777');
  });

  it('calls postComment for Reddit reply', async () => {
    const postComment = vi.fn().mockResolvedValue({ id: 't1_xyz', permalink: '/r/sub/comments/abc/_/xyz/' });
    const submitPost = vi.fn();
    const client = Object.create(RedditClient.prototype) as RedditClient;
    Object.assign(client, { postComment, submitPost });

    const result = await postViaDirectMode({
      platform: 'reddit',
      draftType: 'reply',
      draftText: 'reddit reply',
      threadExternalId: 'abc',
      threadCommunity: 'sub',
      postTitle: null,
      client,
    });
    expect(postComment).toHaveBeenCalledWith('t3_abc', 'reddit reply');
    expect(result.externalId).toBe('t1_xyz');
    expect(result.externalUrl).toBe('https://reddit.com/r/sub/comments/abc/_/xyz/');
  });

  it('calls submitPost for Reddit original_post', async () => {
    const postComment = vi.fn();
    const submitPost = vi.fn().mockResolvedValue({ id: 't3_pqr', url: 'https://reddit.com/r/sub/comments/pqr/' });
    const client = Object.create(RedditClient.prototype) as RedditClient;
    Object.assign(client, { postComment, submitPost });

    const result = await postViaDirectMode({
      platform: 'reddit',
      draftType: 'original_post',
      draftText: 'self post body',
      threadExternalId: null,
      threadCommunity: 'sub',
      postTitle: 'My title',
      client,
    });
    // Positional args: submitPost(subreddit, title, text)
    expect(submitPost).toHaveBeenCalledWith('sub', 'My title', 'self post body');
    expect(result.externalId).toBe('t3_pqr');
    expect(result.externalUrl).toBe('https://reddit.com/r/sub/comments/pqr/');
  });

  it('returns success:false on thrown error', async () => {
    const postTweet = vi.fn().mockRejectedValue(new Error('rate limited'));
    const client = Object.create(XClient.prototype) as XClient;
    Object.assign(client, { postTweet, replyToTweet: vi.fn() });

    const result = await postViaDirectMode({
      platform: 'x',
      draftType: 'original_post',
      draftText: 'oops',
      threadExternalId: null,
      threadCommunity: 'topic',
      postTitle: null,
      client,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('rate limited');
  });
});
