import { describe, it, expect, vi, beforeEach } from 'vitest';

const respondConversationalMock = vi.fn();
vi.mock('@/lib/xai-client', () => ({
  XAIClient: class {
    respondConversational = respondConversationalMock;
  },
}));

import { xaiFindCustomersTool } from '../XaiFindCustomersTool';

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

describe('xai_find_customers tool', () => {
  beforeEach(() => {
    respondConversationalMock.mockReset();
    process.env.XAI_MODEL_FAST = 'grok-4.20-non-reasoning';
    process.env.XAI_MODEL_REASONING = 'grok-4.20-reasoning';
  });

  it('forwards messages array verbatim and uses fast model when reasoning=false', async () => {
    respondConversationalMock.mockResolvedValueOnce({
      output: { tweets: [], notes: 'no matches' },
      assistantMessage: { role: 'assistant', content: '{"tweets":[],"notes":"no matches"}' },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });

    const result = await xaiFindCustomersTool.execute(
      {
        messages: [{ role: 'user', content: 'find indie founders' }],
        productContext: PRODUCT,
        reasoning: false,
      },
      makeCtx({}),
    );

    expect(respondConversationalMock).toHaveBeenCalledTimes(1);
    const call = respondConversationalMock.mock.calls[0]![0];
    expect(call.model).toBe('grok-4.20-non-reasoning');
    expect(call.messages).toEqual([{ role: 'user', content: 'find indie founders' }]);
    expect(call.tools).toEqual([{ type: 'x_search' }]);
    expect(call.responseFormat).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'CustomerTweets', strict: true },
    });

    expect(result.tweets).toEqual([]);
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

    await xaiFindCustomersTool.execute(
      {
        messages: [{ role: 'user', content: 'x' }],
        productContext: PRODUCT,
        reasoning: true,
      },
      makeCtx({}),
    );

    expect(respondConversationalMock.mock.calls[0]![0].model).toBe('grok-4.20-reasoning');
  });

  it('emits tool_progress before and after the xAI call', async () => {
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

    await xaiFindCustomersTool.execute(
      {
        messages: [{ role: 'user', content: 'x' }],
        productContext: PRODUCT,
        reasoning: false,
      },
      ctx,
    );

    expect(emit).toHaveBeenCalled();
    const calls = emit.mock.calls.map((c) => c.slice(0, 2));
    // Pre-call progress mentions "Asking Grok" and the model variant.
    expect(calls[0]).toEqual([
      'xai_find_customers',
      expect.stringMatching(/Asking Grok \(fast\)/),
    ]);
    // Post-call progress mentions the result count.
    expect(calls[calls.length - 1]).toEqual([
      'xai_find_customers',
      expect.stringMatching(/Got 1 candidate/),
    ]);
  });

  it('throws when xAI response fails the tweet schema (zod validation)', async () => {
    respondConversationalMock.mockResolvedValueOnce({
      output: { tweets: [{ external_id: 't1' /* missing required fields */ }], notes: '' },
      assistantMessage: { role: 'assistant', content: '...' },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });

    await expect(
      xaiFindCustomersTool.execute(
        {
          messages: [{ role: 'user', content: 'x' }],
          productContext: PRODUCT,
          reasoning: false,
        },
        makeCtx({}),
      ),
    ).rejects.toThrow();
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

    const result = await xaiFindCustomersTool.execute(
      {
        messages: [{ role: 'user', content: 'x' }],
        productContext: PRODUCT,
        reasoning: false,
      },
      makeCtx({}),
    );

    // No throw — degraded path returns synthesized empty response.
    expect(result.tweets).toEqual([]);
    expect(result.notes).toContain('No strong, high-quality matches');
    expect(result.assistantMessage.content).toContain('No strong, high-quality matches');
  });

  it('propagates xAI HTTP errors verbatim (no swallow)', async () => {
    respondConversationalMock.mockRejectedValueOnce(new Error('xAI API error 429: rate limit'));

    await expect(
      xaiFindCustomersTool.execute(
        {
          messages: [{ role: 'user', content: 'x' }],
          productContext: PRODUCT,
          reasoning: false,
        },
        makeCtx({}),
      ),
    ).rejects.toThrow(/rate limit/);
  });
});
