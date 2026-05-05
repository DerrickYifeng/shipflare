import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { XAIClient } from '../xai-client';

describe('XAIClient.respondConversational', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('forwards messages, tools, and response_format to xAI Responses API', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'resp-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: '{"tweets":[],"notes":"none"}',
              },
            ],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      }),
    });

    const client = new XAIClient('test-key');
    const result = await client.respondConversational({
      model: 'grok-4.20-non-reasoning',
      messages: [
        { role: 'user', content: 'find me indie founders' },
      ],
      tools: [{ type: 'x_search' }],
      responseFormat: {
        type: 'json_schema',
        json_schema: {
          name: 'TweetList',
          schema: {
            type: 'object',
            properties: { tweets: { type: 'array' }, notes: { type: 'string' } },
            required: ['tweets', 'notes'],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    });

    // Output is the parsed JSON.
    expect(result.output).toEqual({ tweets: [], notes: 'none' });
    // Assistant message preserved verbatim for the agent to thread back.
    expect(result.assistantMessage.role).toBe('assistant');
    expect(result.assistantMessage.content).toBe('{"tweets":[],"notes":"none"}');

    // Verify the request body shape sent to xAI.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.x.ai/v1/responses');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('grok-4.20-non-reasoning');
    expect(body.input).toEqual([{ role: 'user', content: 'find me indie founders' }]);
    expect(body.tools).toEqual([{ type: 'x_search' }]);
    // Responses API: structured output is `text.format`, NOT `response_format`.
    // (The chat-completions endpoint uses `response_format`; the Responses
    // endpoint uses `text.format`. Sending the wrong key gets silently
    // ignored, which is what we hit in production before this fix.)
    expect(body.response_format).toBeUndefined();
    expect(body.text).toMatchObject({
      format: {
        type: 'json_schema',
        name: 'TweetList',
        strict: true,
        schema: {
          type: 'object',
          properties: { tweets: { type: 'array' }, notes: { type: 'string' } },
          required: ['tweets', 'notes'],
          additionalProperties: false,
        },
      },
    });
  });

  it('throws on non-2xx HTTP response (no swallow)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'internal server error',
    });

    const client = new XAIClient('test-key');
    await expect(
      client.respondConversational({
        model: 'grok-4.20-non-reasoning',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow(/xAI API error 500/);
  });

  it('returns output=null and parseError when xAI ignores response_format and returns prose', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'resp-1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'No strong matches found.' }],
          },
        ],
      }),
    });

    const client = new XAIClient('test-key');
    const result = await client.respondConversational({
      model: 'grok-4.20-non-reasoning',
      messages: [{ role: 'user', content: 'x' }],
      responseFormat: {
        type: 'json_schema',
        json_schema: { name: 'X', schema: {}, strict: true },
      },
    });

    // Degraded path: no throw — caller decides how to interpret.
    expect(result.output).toBeNull();
    expect(result.parseError).toBeDefined();
    expect(typeof result.parseError).toBe('string');
    // Raw text preserved verbatim for caller to extract prose.
    expect(result.assistantMessage.content).toBe('No strong matches found.');
  });
});

describe('XAIClient log redaction', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('does not log raw query strings or model output', async () => {
    // Capture every line the structured logger writes — both pretty and JSON
    // modes route through console.log/console.error.
    const logged: string[] = [];
    const captureSpy = (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(captureSpy);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(captureSpy);
    // Force debug to fire so the search-request log is exercised.
    const prevLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';

    try {
      // searchTweets: literal query string must not appear in any log line.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'resp-1',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'NO_RESULTS' }],
            },
          ],
          server_side_tool_usage: { x_search_calls: 1, web_search_calls: 0 },
        }),
      });

      const client = new XAIClient('test-key');
      const sensitiveQuery = 'startup founders complaining about cold outreach';
      await client.searchTweets(sensitiveQuery);

      // respondConversational: prose-fallback path includes raw text snippet
      // historically — verify the redacted version no longer leaks it.
      const sensitiveProse =
        'this is sensitive grok output containing customer ICP signals that should never reach a third-party logger';
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'resp-2',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: sensitiveProse }],
            },
          ],
        }),
      });
      await client.respondConversational({
        model: 'grok-4.20-non-reasoning',
        messages: [{ role: 'user', content: 'x' }],
        responseFormat: {
          type: 'json_schema',
          json_schema: { name: 'X', schema: {}, strict: true },
        },
      });

      const allLogs = logged.join('\n');
      // No fragment of the raw query string should appear.
      expect(allLogs).not.toContain('startup founders');
      expect(allLogs).not.toContain('cold outreach');
      // No fragment of the raw model prose should appear.
      expect(allLogs).not.toContain('sensitive grok output');
      expect(allLogs).not.toContain('customer ICP signals');
      // The redacted log lines DO contain length-only summaries.
      expect(allLogs).toContain('query length=');
      expect(allLogs).toContain('text_length=');
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      if (prevLevel === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = prevLevel;
      }
    }
  });
});
