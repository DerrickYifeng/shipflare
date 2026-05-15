import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreateMock = vi.fn();
// Use a regular function (constructable) for the mock impl. Vitest 4's
// vi.fn forwards `new` via Reflect.construct, which throws on arrow
// functions ("is not a constructor"). A regular function works under
// `new` and returns the explicit object.
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function MockAnthropic() {
    return {
      messages: {
        create: (...args: unknown[]) => messagesCreateMock(...args),
      },
    };
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

beforeEach(() => {
  messagesCreateMock.mockReset();
});

describe('web_search', () => {
  it('returns parsed results from Anthropic web_search_20250305 response', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'Found relevant pages:' },
        { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'q' } },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srv_1',
          content: [
            { title: 'Page A', url: 'https://example.com/a' },
            { title: 'Page B', url: 'https://example.com/b' },
          ],
        },
      ],
    });

    const { webSearchTool } = await import('../WebSearchTool');
    const result = await webSearchTool.execute(
      { query: 'indie SaaS waitlist baseline' },
      {} as never,
    );

    expect(result.query).toBe('indie SaaS waitlist baseline');
    expect(result.results).toEqual([
      'Found relevant pages:',
      {
        tool_use_id: 'srv_1',
        content: [
          { title: 'Page A', url: 'https://example.com/a' },
          { title: 'Page B', url: 'https://example.com/b' },
        ],
      },
    ]);
    expect(result.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it('passes allowed_domains through to the tool config', async () => {
    messagesCreateMock.mockResolvedValueOnce({ content: [] });
    const { webSearchTool } = await import('../WebSearchTool');
    await webSearchTool.execute(
      { query: 'q', allowed_domains: ['example.com'] },
      {} as never,
    );
    expect(messagesCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: 'web_search_20250305',
            allowed_domains: ['example.com'],
          }),
        ]),
      }),
    );
  });

  it('rejects when both allowed_domains and blocked_domains are set', async () => {
    const { webSearchInputSchema } = await import('../WebSearchTool');
    const parse = webSearchInputSchema.safeParse({
      query: 'q',
      allowed_domains: ['a.com'],
      blocked_domains: ['b.com'],
    });
    expect(parse.success).toBe(false);
  });

  it('surfaces server-side error_code as a string in results[]', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [
        { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'q' } },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srv_1',
          content: { error_code: 'rate_limited' },
        },
      ],
    });

    const { webSearchTool } = await import('../WebSearchTool');
    const result = await webSearchTool.execute({ query: 'q' }, {} as never);
    expect(result.results.some((r) => typeof r === 'string' && r.includes('rate_limited'))).toBe(
      true,
    );
  });

  it('returns soft error when Anthropic API call throws', async () => {
    messagesCreateMock.mockRejectedValueOnce(new Error('connection reset'));
    const { webSearchTool } = await import('../WebSearchTool');
    const result = await webSearchTool.execute({ query: 'q' }, {} as never);
    expect(result.query).toBe('q');
    expect(
      result.results.some(
        (r) =>
          typeof r === 'string' && r.includes('Web search failed') && r.includes('connection reset'),
      ),
    ).toBe(true);
    expect(result.durationSeconds).toBeGreaterThanOrEqual(0);
  });
});
