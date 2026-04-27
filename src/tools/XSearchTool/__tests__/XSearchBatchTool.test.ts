import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@/core/types';
import type {
  XAIClient,
  XSearchBatchInput,
  XSearchBatchResult,
  XAuthorBio,
} from '@/lib/xai-client';
import { xSearchBatchTool } from '../XSearchBatchTool';

function makeCtx(deps: Record<string, unknown>): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    get<V>(key: string): V {
      if (!(key in deps)) throw new Error(`no dep ${key}`);
      return deps[key] as V;
    },
  };
}

interface MockClientOpts {
  searchTweetsBatch: (
    queries: XSearchBatchInput[],
  ) => Promise<XSearchBatchResult[]>;
  fetchUserBios?: (handles: string[]) => Promise<XAuthorBio[]>;
}

function makeClient(opts: MockClientOpts): XAIClient {
  return {
    searchTweetsBatch: opts.searchTweetsBatch,
    fetchUserBios: opts.fetchUserBios ?? (async () => []),
  } as unknown as XAIClient;
}

describe('x_search_batch tool', () => {
  it('appends original-posts filter to every query', async () => {
    const spy = vi.fn(async (queries: XSearchBatchInput[]) =>
      queries.map((q) => ({ queryId: q.id, tweets: [] })),
    );
    const ctx = makeCtx({ xaiClient: makeClient({ searchTweetsBatch: spy }) });

    await xSearchBatchTool.execute(
      {
        queries: [
          { id: 'a', query: 'from:alice pricing', maxResults: 5 },
          { id: 'b', query: '"zapier alternative"', maxResults: 5 },
        ],
      },
      ctx,
    );

    expect(spy).toHaveBeenCalledOnce();
    const passed = spy.mock.calls[0]![0];
    expect(passed[0]?.query).toBe('from:alice pricing -is:retweet -is:reply');
    expect(passed[1]?.query).toBe('"zapier alternative" -is:retweet -is:reply');
  });

  it('passes through when caller opts into replies or retweets', async () => {
    const spy = vi.fn(async (queries: XSearchBatchInput[]) =>
      queries.map((q) => ({ queryId: q.id, tweets: [] })),
    );
    const ctx = makeCtx({ xaiClient: makeClient({ searchTweetsBatch: spy }) });

    await xSearchBatchTool.execute(
      {
        queries: [
          { id: 'a', query: 'from:alice is:reply', maxResults: 5 },
          { id: 'b', query: 'stripe is:retweet', maxResults: 5 },
          { id: 'c', query: 'normal query', maxResults: 5 },
        ],
      },
      ctx,
    );

    const passed = spy.mock.calls[0]![0];
    expect(passed[0]?.query).toBe('from:alice is:reply');
    expect(passed[1]?.query).toBe('stripe is:retweet');
    expect(passed[2]?.query).toBe('normal query -is:retweet -is:reply');
  });

  it('reshapes tweets into id/url/text and an enriched author object', async () => {
    const fetchUserBios = vi.fn(async (_handles: string[]) => [
      { username: 'alice', bio: 'building something', followerCount: 1200 },
    ]);
    const client = makeClient({
      searchTweetsBatch: async (queries) =>
        queries.map((q) => ({
          queryId: q.id,
          tweets: [
            {
              tweetId: '111',
              url: 'https://x.com/alice/status/111',
              authorUsername: 'alice',
              text: 'hello',
            },
          ],
        })),
      fetchUserBios,
    });
    const ctx = makeCtx({ xaiClient: client });

    const result = await xSearchBatchTool.execute(
      { queries: [{ id: 'q1', query: 'hi', maxResults: 5 }] },
      ctx,
    );

    expect(fetchUserBios).toHaveBeenCalledOnce();
    expect(fetchUserBios.mock.calls[0]![0]).toEqual(['alice']);
    expect(result).toEqual([
      {
        queryId: 'q1',
        tweets: [
          {
            id: '111',
            url: 'https://x.com/alice/status/111',
            text: 'hello',
            author: {
              handle: 'alice',
              bio: 'building something',
              followerCount: 1200,
            },
          },
        ],
      },
    ]);
  });

  it('deduplicates author handles across queries before fetching bios', async () => {
    const fetchUserBios = vi.fn(async (handles: string[]) =>
      handles.map((h) => ({ username: h, bio: `${h}-bio`, followerCount: 10 })),
    );
    const client = makeClient({
      searchTweetsBatch: async (queries) =>
        queries.map((q) => ({
          queryId: q.id,
          tweets: [
            {
              tweetId: `${q.id}-1`,
              url: `https://x.com/alice/status/${q.id}-1`,
              authorUsername: 'alice', // same handle in both queries
              text: 'tweet',
            },
            {
              tweetId: `${q.id}-2`,
              url: `https://x.com/bob/status/${q.id}-2`,
              authorUsername: 'bob',
              text: 'tweet',
            },
          ],
        })),
      fetchUserBios,
    });
    const ctx = makeCtx({ xaiClient: client });

    await xSearchBatchTool.execute(
      {
        queries: [
          { id: 'q1', query: 'a', maxResults: 5 },
          { id: 'q2', query: 'b', maxResults: 5 },
        ],
      },
      ctx,
    );

    expect(fetchUserBios).toHaveBeenCalledOnce();
    const handlesPassed = fetchUserBios.mock.calls[0]![0];
    expect(handlesPassed.sort()).toEqual(['alice', 'bob']);
  });

  it('matches bios case-insensitively and strips leading @', async () => {
    const client = makeClient({
      searchTweetsBatch: async (queries) =>
        queries.map((q) => ({
          queryId: q.id,
          tweets: [
            {
              tweetId: '111',
              url: 'https://x.com/Alice/status/111',
              authorUsername: '@Alice',
              text: 'hi',
            },
          ],
        })),
      fetchUserBios: async () => [
        { username: 'alice', bio: 'matched', followerCount: 5 },
      ],
    });
    const ctx = makeCtx({ xaiClient: client });

    const result = await xSearchBatchTool.execute(
      { queries: [{ id: 'q1', query: 'x', maxResults: 5 }] },
      ctx,
    );
    expect(result[0]!.tweets[0]!.author.bio).toBe('matched');
  });

  it('returns null bio + followerCount when fetchUserBios throws (graceful degrade)', async () => {
    const client = makeClient({
      searchTweetsBatch: async (queries) =>
        queries.map((q) => ({
          queryId: q.id,
          tweets: [
            {
              tweetId: '111',
              url: 'https://x.com/alice/status/111',
              authorUsername: 'alice',
              text: 'hi',
            },
          ],
        })),
      fetchUserBios: async () => {
        throw new Error('xAI timeout');
      },
    });
    const ctx = makeCtx({ xaiClient: client });

    const result = await xSearchBatchTool.execute(
      { queries: [{ id: 'q1', query: 'x', maxResults: 5 }] },
      ctx,
    );
    expect(result[0]!.tweets[0]!.author).toEqual({
      handle: 'alice',
      bio: null,
      followerCount: null,
    });
  });

  it('skips bio fetch entirely when there are no tweets', async () => {
    const fetchUserBios = vi.fn(async () => []);
    const client = makeClient({
      searchTweetsBatch: async (queries) =>
        queries.map((q) => ({ queryId: q.id, tweets: [] })),
      fetchUserBios,
    });
    const ctx = makeCtx({ xaiClient: client });

    await xSearchBatchTool.execute(
      { queries: [{ id: 'q1', query: 'x', maxResults: 5 }] },
      ctx,
    );
    expect(fetchUserBios).not.toHaveBeenCalled();
  });

  it('rejects empty queries arrays via schema', async () => {
    const parse = xSearchBatchTool.inputSchema.safeParse({ queries: [] });
    expect(parse.success).toBe(false);
  });

  it('rejects more than the per-batch query cap via schema', async () => {
    // Cap is exposed via SEARCH_TWEETS_BATCH_MAX_QUERIES (20). Anything
    // over should fail; 20 itself should pass.
    const overCap = xSearchBatchTool.inputSchema.safeParse({
      queries: Array.from({ length: 21 }, (_, i) => ({
        id: `q${i}`,
        query: 'x',
        maxResults: 5,
      })),
    });
    expect(overCap.success).toBe(false);

    const atCap = xSearchBatchTool.inputSchema.safeParse({
      queries: Array.from({ length: 20 }, (_, i) => ({
        id: `q${i}`,
        query: 'x',
        maxResults: 5,
      })),
    });
    expect(atCap.success).toBe(true);
  });

  it('applies maxResults default of 10 when omitted', async () => {
    const parse = xSearchBatchTool.inputSchema.safeParse({
      queries: [{ id: 'q1', query: 'hi' }],
    });
    expect(parse.success).toBe(true);
    if (parse.success) {
      expect(parse.data.queries[0]?.maxResults).toBe(10);
    }
  });
});
