import { describe, it, expect, vi, beforeEach } from 'vitest';

const respondConversationalMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/xai-client', () => ({
  XAIClient: class {
    respondConversational = respondConversationalMock;
  },
}));

const warnMock = vi.hoisted(() => vi.fn());
const infoMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: infoMock,
    warn: warnMock,
    error: () => {},
  }),
}));

import { xaiFindCustomersTool } from '../XaiFindCustomersTool';
import { tweetCandidateSchema } from '../schema';

function makeCtx(deps: Record<string, unknown>): {
  abortSignal: AbortSignal;
  emitProgress?: (toolName: string, message: string, metadata?: Record<string, unknown>) => void;
  get<V>(key: string): V;
} {
  return {
    abortSignal: new AbortController().signal,
    get<V>(key: string): V {
      if (key in deps) return deps[key] as V;
      throw new Error(`no dep ${key}`);
    },
  };
}

const PRODUCT = {
  name: 'ShipFlare',
  description: 'AI marketing teammates for builders',
  valueProp: 'Ship without babysitting marketing',
  targetAudience: 'Indie devs building SaaS',
  keywords: ['indie', 'marketing', 'automation'],
};

/**
 * Minimal input the tool now requires. Both `tools` and the
 * `responseFormat*` fields are caller-owned per the new contract — a
 * platform-agnostic test fixture passes plausible values for both.
 */
const X_SEARCH_TOOLS = [{ type: 'x_search' as const }];
const X_TWEET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tweets', 'notes'],
  properties: {
    tweets: { type: 'array', items: { type: 'object' } },
    notes: { type: 'string' },
  },
} as const;

function baseInput(overrides: Partial<Parameters<typeof xaiFindCustomersTool.execute>[0]> = {}) {
  return {
    messages: [{ role: 'user' as const, content: 'find indie founders' }],
    productContext: PRODUCT,
    reasoning: false,
    tools: X_SEARCH_TOOLS,
    responseFormatSchema: X_TWEET_SCHEMA,
    responseFormatName: 'tweet_search_result',
    ...overrides,
  };
}

describe('xai_find_customers tool', () => {
  beforeEach(() => {
    respondConversationalMock.mockReset();
    warnMock.mockReset();
    infoMock.mockReset();
    process.env.XAI_MODEL_FAST = 'grok-4.20-non-reasoning';
    process.env.XAI_MODEL_REASONING = 'grok-4.20-reasoning';
  });

  it('forwards messages, tools, and responseFormat verbatim and uses fast model when reasoning=false', async () => {
    respondConversationalMock.mockResolvedValueOnce({
      output: { tweets: [], notes: 'no matches' },
      assistantMessage: { role: 'assistant', content: '{"tweets":[],"notes":"no matches"}' },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });

    const result = await xaiFindCustomersTool.execute(baseInput(), makeCtx({}));

    expect(respondConversationalMock).toHaveBeenCalledTimes(1);
    const call = respondConversationalMock.mock.calls[0]![0];
    expect(call.model).toBe('grok-4.20-non-reasoning');
    expect(call.messages).toEqual([{ role: 'user', content: 'find indie founders' }]);
    expect(call.tools).toEqual(X_SEARCH_TOOLS);
    expect(call.responseFormat).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'tweet_search_result',
        schema: X_TWEET_SCHEMA,
        strict: true,
      },
    });

    expect(result.output).toEqual({ tweets: [], notes: 'no matches' });
    expect(result.notes).toBe('no matches');
    expect(result.assistantMessage.role).toBe('assistant');
    expect(result.assistantMessage.content).toContain('"tweets":[]');
  });

  it('uses reasoning model when reasoning=true', async () => {
    respondConversationalMock.mockResolvedValueOnce({
      output: { tweets: [], notes: '' },
      assistantMessage: { role: 'assistant', content: '{"tweets":[],"notes":""}' },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });

    await xaiFindCustomersTool.execute(baseInput({ reasoning: true }), makeCtx({}));

    expect(respondConversationalMock.mock.calls[0]![0].model).toBe('grok-4.20-reasoning');
  });

  it('routes Reddit-shaped requests through the same path (different schema + tools)', async () => {
    const REDDIT_SCHEMA = {
      type: 'object',
      additionalProperties: false,
      required: ['threads', 'notes'],
      properties: {
        threads: { type: 'array', items: { type: 'object' } },
        notes: { type: 'string' },
      },
    } as const;
    respondConversationalMock.mockResolvedValueOnce({
      output: { threads: [{ id: 't1' }, { id: 't2' }], notes: 'two reddit hits' },
      assistantMessage: { role: 'assistant', content: '{"threads":[…]}' },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });

    const result = await xaiFindCustomersTool.execute(
      baseInput({
        tools: [{ type: 'web_search', allowed_domains: ['reddit.com'] }],
        responseFormatSchema: REDDIT_SCHEMA,
        responseFormatName: 'reddit_thread_search_result',
      }),
      makeCtx({}),
    );

    expect(result.output).toEqual({
      threads: [{ id: 't1' }, { id: 't2' }],
      notes: 'two reddit hits',
    });
    expect(result.notes).toBe('two reddit hits');
  });

  it('emits tool_progress before and after the xAI call with the candidate count', async () => {
    respondConversationalMock.mockResolvedValueOnce({
      output: {
        tweets: [
          {
            external_id: 't1',
            url: 'https://x.com/a/status/1',
            author_username: 'alice',
            author_bio: null,
            author_followers: null,
            body: 'help me ship',
            posted_at: '2026-04-26T00:00:00Z',
            likes_count: 5,
            reposts_count: 0,
            replies_count: 1,
            views_count: 100,
            is_repost: false,
            original_url: null,
            original_author_username: null,
            surfaced_via: null,
            confidence: 0.8,
            reason: 'asking for marketing automation',
          },
        ],
        notes: '1 strong match',
      },
      assistantMessage: { role: 'assistant', content: '...' },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });

    const emit = vi.fn();
    const ctx = makeCtx({});
    ctx.emitProgress = emit;

    await xaiFindCustomersTool.execute(baseInput(), ctx);

    expect(emit).toHaveBeenCalled();
    const calls = emit.mock.calls.map((c) => c.slice(0, 2));
    expect(calls[0]).toEqual([
      'xai_find_customers',
      expect.stringMatching(/Asking Grok \(fast\)/),
    ]);
    expect(calls[calls.length - 1]).toEqual([
      'xai_find_customers',
      expect.stringMatching(/Got 1 candidate/),
    ]);
  });

  it('synthesizes empty result + prose-as-notes when xAI returns non-JSON (output: null)', async () => {
    respondConversationalMock.mockResolvedValueOnce({
      output: null,
      parseError: 'Unexpected token N in JSON at position 0',
      assistantMessage: {
        role: 'assistant',
        content: '**No strong, high-quality matches found** in the last 7 days.',
      },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });

    const result = await xaiFindCustomersTool.execute(baseInput(), makeCtx({}));

    expect(result.output).toBeNull();
    expect(result.notes).toContain('No strong, high-quality matches');
    expect(result.assistantMessage.content).toContain('No strong, high-quality matches');
  });

  it('warns when notes claims matches but the structured output array is empty (Grok hallucination)', async () => {
    respondConversationalMock.mockResolvedValueOnce({
      output: { tweets: [], notes: 'Found 5 genuine, high-relevance matches from indie devs.' },
      assistantMessage: { role: 'assistant', content: '...' },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });

    await xaiFindCustomersTool.execute(baseInput(), makeCtx({}));

    expect(warnMock).toHaveBeenCalled();
    const warnCall = warnMock.mock.calls.find((c) =>
      String(c[0]).includes('Grok prose hallucination'),
    );
    expect(warnCall).toBeDefined();
    expect(String(warnCall![0])).toContain('Found 5 genuine');
  });

  it('does not warn when notes is empty even with empty arrays', async () => {
    respondConversationalMock.mockResolvedValueOnce({
      output: { tweets: [], notes: '' },
      assistantMessage: { role: 'assistant', content: '...' },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });

    await xaiFindCustomersTool.execute(baseInput(), makeCtx({}));

    const hallucinationWarn = warnMock.mock.calls.find((c) =>
      String(c[0]).includes('Grok prose hallucination'),
    );
    expect(hallucinationWarn).toBeUndefined();
  });

  it('propagates xAI HTTP errors verbatim (no swallow)', async () => {
    respondConversationalMock.mockRejectedValueOnce(new Error('xAI API error 429: rate limit'));

    await expect(
      xaiFindCustomersTool.execute(baseInput(), makeCtx({})),
    ).rejects.toThrow(/rate limit/);
  });
});

describe('tweetCandidateSchema conversation context', () => {
  const baseTweet = {
    external_id: 't1',
    url: 'https://x.com/a/status/1',
    author_username: 'alice',
    author_bio: null,
    author_followers: null,
    body: 'building',
    posted_at: '2026-05-04T00:00:00.000Z',
    likes_count: null,
    reposts_count: null,
    replies_count: null,
    views_count: null,
    is_repost: false,
    original_url: null,
    original_author_username: null,
    surfaced_via: null,
    confidence: 0.7,
    reason: 'pain match',
  };

  it('parses with all four conversation fields null', () => {
    const parsed = tweetCandidateSchema.parse({
      ...baseTweet,
      quoted_text: null,
      quoted_author: null,
      in_reply_to_text: null,
      in_reply_to_author: null,
    });
    expect(parsed.quoted_text).toBeNull();
    expect(parsed.in_reply_to_text).toBeNull();
  });

  it('parses a quote-tweet (quoted_text + quoted_author populated)', () => {
    const parsed = tweetCandidateSchema.parse({
      ...baseTweet,
      quoted_text: 'OMG this actually worked',
      quoted_author: 'anumness',
      in_reply_to_text: null,
      in_reply_to_author: null,
    });
    expect(parsed.quoted_text).toBe('OMG this actually worked');
    expect(parsed.quoted_author).toBe('anumness');
  });

  it('parses a self-quote (quoted_author == author_username)', () => {
    const parsed = tweetCandidateSchema.parse({
      ...baseTweet,
      author_username: 'anumness',
      quoted_text: 'OMG this actually worked',
      quoted_author: 'anumness',
      in_reply_to_text: null,
      in_reply_to_author: null,
    });
    expect(parsed.quoted_author).toBe(parsed.author_username);
  });

  it('parses a reply-in-thread (in_reply_to_* populated)', () => {
    const parsed = tweetCandidateSchema.parse({
      ...baseTweet,
      quoted_text: null,
      quoted_author: null,
      in_reply_to_text: 'what marketing channels worked for you?',
      in_reply_to_author: 'somefounder',
    });
    expect(parsed.in_reply_to_text).toContain('marketing channels');
  });

  it('back-compat: parses without the new fields at all', () => {
    expect(() => tweetCandidateSchema.parse(baseTweet)).not.toThrow();
  });
});
