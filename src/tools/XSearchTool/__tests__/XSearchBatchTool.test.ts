import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@/core/types';
import type {
  XAIClient,
  XSearchBatchInput,
  XSearchBatchResult,
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

function makeClient(
  searchTweetsBatch: (
    queries: XSearchBatchInput[],
  ) => Promise<XSearchBatchResult[]>,
): XAIClient {
  return { searchTweetsBatch } as unknown as XAIClient;
}

describe('x_search_batch tool', () => {
  it('appends original-posts filter to every query', async () => {
    const spy = vi.fn(async (queries: XSearchBatchInput[]) =>
      queries.map((q) => ({ queryId: q.id, tweets: [] })),
    );
    const ctx = makeCtx({ xaiClient: makeClient(spy) });

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
    const ctx = makeCtx({ xaiClient: makeClient(spy) });

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

  it('reshapes XAIClient tweets into the tool output schema', async () => {
    const client = makeClient(async (queries) =>
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
    );
    const ctx = makeCtx({ xaiClient: client });

    const result = await xSearchBatchTool.execute(
      { queries: [{ id: 'q1', query: 'hi', maxResults: 5 }] },
      ctx,
    );

    expect(result).toEqual([
      {
        queryId: 'q1',
        tweets: [
          {
            id: '111',
            url: 'https://x.com/alice/status/111',
            author: 'alice',
            text: 'hello',
          },
        ],
      },
    ]);
  });

  it('rejects empty queries arrays via schema', async () => {
    const parse = xSearchBatchTool.inputSchema.safeParse({ queries: [] });
    expect(parse.success).toBe(false);
  });

  it('rejects more than 10 queries via schema', async () => {
    const parse = xSearchBatchTool.inputSchema.safeParse({
      queries: Array.from({ length: 11 }, (_, i) => ({
        id: `q${i}`,
        query: 'x',
        maxResults: 5,
      })),
    });
    expect(parse.success).toBe(false);
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
