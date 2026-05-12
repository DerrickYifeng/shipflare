import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock global.fetch — the helpers call the Reddit public JSON API directly
// rather than going through `RedditClient.appOnly().get()` because that
// method is private (see `src/lib/reddit-client.ts`). The public-API URL
// shape matches what reddit-client.ts uses internally (`REDDIT_PUBLIC_BASE`).
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  fetchSubredditAbout,
  fetchSubredditActivity,
} from '../reddit-channel-enrichment';

function jsonResponse(body: unknown, init?: { status?: number; ok?: boolean }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  fetchMock.mockReset();
});

describe('fetchSubredditAbout', () => {
  it('returns subscribers from /r/<sub>/about.json', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { subscribers: 250_000 } }),
    );
    const result = await fetchSubredditAbout('SaaS');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://www.reddit.com/r/SaaS/about.json');
    expect(result).toEqual({ memberCount: 250_000 });
  });

  it('returns null memberCount if Reddit returns no data', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null }));
    const result = await fetchSubredditAbout('weird');
    expect(result.memberCount).toBeNull();
  });

  it('swallows errors and returns null fields', async () => {
    fetchMock.mockRejectedValueOnce(new Error('429 rate limit'));
    const result = await fetchSubredditAbout('SaaS');
    expect(result.memberCount).toBeNull();
  });

  it('returns null on non-ok response (e.g. 404)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(null, { ok: false, status: 404 }),
    );
    const result = await fetchSubredditAbout('nonexistent');
    expect(result.memberCount).toBeNull();
  });
});

describe('fetchSubredditActivity', () => {
  it('counts posts in last 7d and computes median upvotes', async () => {
    const now = Math.floor(Date.now() / 1000);
    const day = 86400;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          children: [
            { data: { created_utc: now - 1 * day, score: 10, num_comments: 5 } },
            { data: { created_utc: now - 2 * day, score: 50, num_comments: 20 } },
            {
              data: { created_utc: now - 8 * day, score: 1000, num_comments: 200 },
            },
          ],
        },
      }),
    );
    const result = await fetchSubredditActivity('SaaS');
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://www.reddit.com/r/SaaS/new.json?limit=50');
    expect(result.postsLast7d).toBe(2);
    expect(result.commentsLast7d).toBe(25);
    expect(result.medianUpvotes).toBe(30); // median of [10, 50] = (10+50)/2 = 30
  });

  it('returns zeros on error, not a throw', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    const result = await fetchSubredditActivity('SaaS');
    expect(result).toEqual({
      postsLast7d: 0,
      commentsLast7d: 0,
      medianUpvotes: 0,
    });
  });

  it('returns zeros when listing has no recent posts', async () => {
    const now = Math.floor(Date.now() / 1000);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          children: [
            { data: { created_utc: now - 30 * 86400, score: 100, num_comments: 10 } },
          ],
        },
      }),
    );
    const result = await fetchSubredditActivity('SaaS');
    expect(result).toEqual({
      postsLast7d: 0,
      commentsLast7d: 0,
      medianUpvotes: 0,
    });
  });

  it('handles odd-count medians (returns middle element)', async () => {
    const now = Math.floor(Date.now() / 1000);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          children: [
            { data: { created_utc: now - 1, score: 5, num_comments: 1 } },
            { data: { created_utc: now - 2, score: 15, num_comments: 2 } },
            { data: { created_utc: now - 3, score: 25, num_comments: 3 } },
          ],
        },
      }),
    );
    const result = await fetchSubredditActivity('SaaS');
    expect(result.postsLast7d).toBe(3);
    expect(result.medianUpvotes).toBe(15);
  });
});
