import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

// Mock the createMessage seam (src/core/api-client) so we can capture the
// messages array passed to Anthropic without actually calling the LLM.
const createMessageMock = vi.fn();
vi.mock('@/core/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/core/api-client')>(
    '@/core/api-client',
  );
  return {
    ...actual,
    createMessage: (...args: unknown[]) => createMessageMock(...args),
  };
});

import { runAgent } from '@/core/query-loop';
import type { AgentConfig, ToolContext } from '@/core/types';

function fakeCtx(): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    get: <V>(_key: string) => null as unknown as V,
  };
}

function fakeConfig(systemPrompt: string): AgentConfig {
  return {
    name: 'test-agent',
    systemPrompt,
    model: 'claude-haiku-4-5',
    tools: [],
    maxTurns: 1,
  };
}

// One-turn end_turn response so runAgent exits after the first createMessage.
// Usage shape mirrors the real `CreateMessageResult` (camelCase) from
// src/core/api-client.ts so the unmocked UsageTracker.add doesn't accumulate
// NaN — divergence from the plan, which used snake_case Anthropic-API token
// fields. See report.
function endTurnResponse(): {
  response: Anthropic.Messages.Message;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
} {
  return {
    response: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as Anthropic.Messages.Message,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  };
}

describe('runAgent: prebuilt.forkContextMessages (regression test for skill preload)', () => {
  beforeEach(() => {
    createMessageMock.mockReset();
    createMessageMock.mockResolvedValue(endTurnResponse());
  });

  it('prepends forkContextMessages before the user message', async () => {
    await runAgent(
      fakeConfig('SYSTEM PROMPT BODY'),
      'USER MESSAGE',
      fakeCtx(),
      undefined, // outputSchema
      undefined, // onProgress
      {
        systemBlocks: [],
        forkContextMessages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'PRELOADED SKILL CONTENT' }],
          },
        ],
      },
    );

    expect(createMessageMock).toHaveBeenCalledTimes(1);
    const callArg = createMessageMock.mock.calls[0][0] as {
      messages: Anthropic.Messages.MessageParam[];
    };
    const msgs = callArg.messages;

    // First message is the preloaded skill, second is the user message.
    expect(msgs).toHaveLength(2);
    const firstContent = msgs[0].content;
    const firstStr =
      typeof firstContent === 'string'
        ? firstContent
        : firstContent.map((b) => ('text' in b ? b.text : '')).join('');
    expect(firstStr).toContain('PRELOADED SKILL CONTENT');

    const secondContent = msgs[1].content;
    const secondStr =
      typeof secondContent === 'string'
        ? secondContent
        : secondContent.map((b) => ('text' in b ? b.text : '')).join('');
    expect(secondStr).toBe('USER MESSAGE');
  });

  it('with no prebuilt, only the user message is sent', async () => {
    await runAgent(fakeConfig('SYSTEM'), 'USER MESSAGE', fakeCtx());

    const callArg = createMessageMock.mock.calls[0][0] as {
      messages: Anthropic.Messages.MessageParam[];
    };
    expect(callArg.messages).toHaveLength(1);
  });
});
