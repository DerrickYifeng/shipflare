import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XAIClient, SEARCH_TWEETS_BATCH_MAX_QUERIES } from '../xai-client';

/**
 * These tests cover the batched `searchTweetsBatch` path only. The single
 * `searchTweets` path is unchanged and has its own network-level shape
 * (tweets + citations + rawText) that isn't worth re-covering here.
 */

function mockXaiResponse(text: string, searchCalls = 1): Response {
  return {
    ok: true,
    json: async () => ({
      id: 'resp_test',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        },
      ],
      citations: [],
      server_side_tool_usage: {
        x_search_calls: searchCalls,
        web_search_calls: 0,
      },
    }),
    text: async () => '',
  } as Response;
}

describe('XAIClient.searchTweetsBatch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    process.env.XAI_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('groups tweets by query id and preserves request order', async () => {
    fetchMock.mockResolvedValueOnce(
      mockXaiResponse(
        [
          'TWEET|q1|https://x.com/alice/status/111|alice|hello from alice',
          'TWEET|q2|https://x.com/bob/status/222|bob|hey bob here',
          'TWEET|q1|https://x.com/carol/status/333|carol|carol too',
          'NO_RESULTS|q3',
        ].join('\n'),
        3,
      ),
    );

    const client = new XAIClient();
    const results = await client.searchTweetsBatch([
      { id: 'q1', query: 'from:alice', maxResults: 5 },
      { id: 'q2', query: 'from:bob', maxResults: 5 },
      { id: 'q3', query: 'from:nobody', maxResults: 5 },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]?.queryId).toBe('q1');
    expect(results[0]?.tweets.map((t) => t.tweetId)).toEqual(['111', '333']);
    expect(results[1]?.queryId).toBe('q2');
    expect(results[1]?.tweets).toHaveLength(1);
    expect(results[1]?.tweets[0]?.authorUsername).toBe('bob');
    expect(results[2]?.queryId).toBe('q3');
    expect(results[2]?.tweets).toEqual([]);
  });

  it('drops tweets with unknown query ids (Grok hallucinates)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockXaiResponse(
        [
          'TWEET|q1|https://x.com/a/status/1|a|real',
          'TWEET|q_bogus|https://x.com/x/status/2|x|hallucinated id',
        ].join('\n'),
      ),
    );

    const client = new XAIClient();
    const results = await client.searchTweetsBatch([
      { id: 'q1', query: 'hi', maxResults: 5 },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]?.tweets).toHaveLength(1);
    expect(results[0]?.tweets[0]?.tweetId).toBe('1');
  });

  it('respects per-query maxResults cap', async () => {
    fetchMock.mockResolvedValueOnce(
      mockXaiResponse(
        [
          'TWEET|q1|https://x.com/a/status/1|a|one',
          'TWEET|q1|https://x.com/a/status/2|a|two',
          'TWEET|q1|https://x.com/a/status/3|a|three',
          'TWEET|q1|https://x.com/a/status/4|a|four',
        ].join('\n'),
      ),
    );

    const client = new XAIClient();
    const results = await client.searchTweetsBatch([
      { id: 'q1', query: 'hi', maxResults: 2 },
    ]);

    expect(results[0]?.tweets).toHaveLength(2);
    expect(results[0]?.tweets.map((t) => t.tweetId)).toEqual(['1', '2']);
  });

  it('preserves pipe characters that appear in tweet text', async () => {
    fetchMock.mockResolvedValueOnce(
      mockXaiResponse(
        'TWEET|q1|https://x.com/a/status/1|a|pricing: $10 | month | great',
      ),
    );

    const client = new XAIClient();
    const [first] = await client.searchTweetsBatch([
      { id: 'q1', query: 'pricing', maxResults: 5 },
    ]);

    expect(first?.tweets[0]?.text).toBe('pricing: $10 | month | great');
  });

  it('strips leading @ from author usernames', async () => {
    fetchMock.mockResolvedValueOnce(
      mockXaiResponse('TWEET|q1|https://x.com/alice/status/1|@alice|hi'),
    );

    const client = new XAIClient();
    const [first] = await client.searchTweetsBatch([
      { id: 'q1', query: 'hi', maxResults: 5 },
    ]);

    expect(first?.tweets[0]?.authorUsername).toBe('alice');
  });

  it('skips malformed lines (missing fields, unparseable url)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockXaiResponse(
        [
          'TWEET|q1|https://x.com/a/status/1|a|good',
          'TWEET|q1|not-a-url|a|bad url',
          'TWEET|q1|missing-fields',
          '',
          'random junk line',
          'TWEET|q1|https://x.com/a/status/2|a|also good',
        ].join('\n'),
      ),
    );

    const client = new XAIClient();
    const [first] = await client.searchTweetsBatch([
      { id: 'q1', query: 'hi', maxResults: 5 },
    ]);

    expect(first?.tweets.map((t) => t.tweetId)).toEqual(['1', '2']);
  });

  it('returns empty array when called with no queries (no network call)', async () => {
    const client = new XAIClient();
    const results = await client.searchTweetsBatch([]);
    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when exceeding the max-queries cap', async () => {
    const client = new XAIClient();
    const tooMany = Array.from(
      { length: SEARCH_TWEETS_BATCH_MAX_QUERIES + 1 },
      (_, i) => ({ id: `q${i}`, query: `q ${i}`, maxResults: 5 }),
    );
    await expect(client.searchTweetsBatch(tooMany)).rejects.toThrow(
      /max \d+ queries/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on duplicate query ids', async () => {
    const client = new XAIClient();
    await expect(
      client.searchTweetsBatch([
        { id: 'q1', query: 'a', maxResults: 5 },
        { id: 'q1', query: 'b', maxResults: 5 },
      ]),
    ).rejects.toThrow(/duplicate query id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries once with longer timeout on AbortError', async () => {
    const abortErr = new Error('timeout');
    abortErr.name = 'AbortError';
    fetchMock
      .mockRejectedValueOnce(abortErr)
      .mockResolvedValueOnce(
        mockXaiResponse('TWEET|q1|https://x.com/a/status/1|a|retry ok'),
      );

    const client = new XAIClient();
    const results = await client.searchTweetsBatch([
      { id: 'q1', query: 'hi', maxResults: 5 },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results[0]?.tweets[0]?.tweetId).toBe('1');
  });

  it('propagates non-abort fetch errors without retry', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection refused'));

    const client = new XAIClient();
    await expect(
      client.searchTweetsBatch([{ id: 'q1', query: 'hi', maxResults: 5 }]),
    ).rejects.toThrow(/connection refused/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
