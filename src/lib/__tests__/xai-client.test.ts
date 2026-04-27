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
