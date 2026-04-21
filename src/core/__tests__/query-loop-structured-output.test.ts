/**
 * Unit test for the inline StructuredOutput Stop-check enforcement added to
 * runAgent() in src/core/query-loop.ts.
 *
 * Mocks @/core/api-client's createMessage() so we can script a sequence of
 * Anthropic responses without hitting the real API.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';

// Shape of the mock createMessage's reply. Each test pushes messages onto
// this queue in the order the mock should return them.
interface MockReply {
  response: Anthropic.Messages.Message;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}
const replyQueue: MockReply[] = [];
let createMessageCalls = 0;

// Record the user-role messages runAgent built up — the Stop-check injects
// STRUCTURED_OUTPUT_CORRECTION into this list when the agent forgets the tool.
const capturedMessages: Anthropic.Messages.MessageParam[][] = [];

vi.mock('@/core/api-client', () => ({
  createMessage: vi.fn(async (opts: { messages: Anthropic.Messages.MessageParam[] }) => {
    capturedMessages.push([...opts.messages]);
    createMessageCalls++;
    const next = replyQueue.shift();
    if (!next) {
      throw new Error(
        `mock createMessage: unexpected call #${createMessageCalls} (reply queue empty)`,
      );
    }
    return next;
  }),
  // runAgent imports these but they don't drive behavior under mock.
  UsageTracker: class UsageTracker {
    readonly input = 0;
    readonly output = 0;
    add() {
      /* no-op */
    }
    toSummary() {
      return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        model: 'test',
        turns: 0,
      };
    }
  },
  addMessageCacheBreakpoint: (m: Anthropic.Messages.MessageParam[]) => m,
}));

import { runAgent } from '../query-loop';
import {
  STRUCTURED_OUTPUT_CORRECTION,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from '@/tools/StructuredOutputTool/StructuredOutputTool';

const noopCtx = () => {
  const ac = new AbortController();
  return {
    abortSignal: ac.signal,
    get<T>(key: string): T {
      throw new Error(`no dep ${key}`);
    },
  };
};

function makeAssistantMessage(
  blocks: Anthropic.Messages.ContentBlock[],
  stop: 'end_turn' | 'tool_use',
): Anthropic.Messages.Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    type: 'message',
    role: 'assistant',
    model: 'test',
    content: blocks,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Messages.Message;
}

function pushReply(msg: Anthropic.Messages.Message) {
  replyQueue.push({
    response: msg,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  });
}

beforeEach(() => {
  replyQueue.length = 0;
  capturedMessages.length = 0;
  createMessageCalls = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runAgent — StructuredOutput tool intercept', () => {
  it('returns the validated value when the model calls StructuredOutput with a valid input', async () => {
    const schema = z.object({ pillar: z.string(), count: z.number() });

    // Turn 1: model calls StructuredOutput with a valid input
    pushReply(
      makeAssistantMessage(
        [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: STRUCTURED_OUTPUT_TOOL_NAME,
            input: { pillar: 'growth', count: 3 },
          } as Anthropic.Messages.ToolUseBlock,
        ],
        'tool_use',
      ),
    );

    const result = await runAgent(
      {
        name: 'echo',
        model: 'test',
        maxTurns: 3,
        systemPrompt: 'you are a test',
        tools: [],
      },
      'hello',
      noopCtx(),
      schema,
    );

    expect(result.result).toEqual({ pillar: 'growth', count: 3 });
    expect(createMessageCalls).toBe(1);
  });

  it('feeds a tool_result is_error back when validation fails, then accepts the corrected call', async () => {
    const schema = z.object({ pillar: z.string() });

    // Turn 1: bad input
    pushReply(
      makeAssistantMessage(
        [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: STRUCTURED_OUTPUT_TOOL_NAME,
            input: { pillar: 42 },
          } as Anthropic.Messages.ToolUseBlock,
        ],
        'tool_use',
      ),
    );
    // Turn 2: corrected input
    pushReply(
      makeAssistantMessage(
        [
          {
            type: 'tool_use',
            id: 'tu_2',
            name: STRUCTURED_OUTPUT_TOOL_NAME,
            input: { pillar: 'growth' },
          } as Anthropic.Messages.ToolUseBlock,
        ],
        'tool_use',
      ),
    );

    const result = await runAgent(
      {
        name: 'echo',
        model: 'test',
        maxTurns: 4,
        systemPrompt: 'you are a test',
        tools: [],
      },
      'hello',
      noopCtx(),
      schema,
    );

    expect(result.result).toEqual({ pillar: 'growth' });
    expect(createMessageCalls).toBe(2);
    // On the second call, the last user message must be the is_error tool_result
    const secondCallMessages = capturedMessages[1]!;
    const lastMsg = secondCallMessages[secondCallMessages.length - 1]!;
    expect(lastMsg.role).toBe('user');
    const content = Array.isArray(lastMsg.content) ? lastMsg.content : [];
    expect(content[0]).toMatchObject({
      type: 'tool_result',
      is_error: true,
    });
  });

  it('accepts an end-to-end call with a schema containing minItems>1', async () => {
    // minItems>1 is one of the constructs output_config.format.schema rejects
    // at compile time but tool input_schema accepts. This confirms the
    // intercept path round-trips it without invoking the sanitizer.
    const schema = z.object({
      bugs: z.array(z.string()).min(3),
    });

    pushReply(
      makeAssistantMessage(
        [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: STRUCTURED_OUTPUT_TOOL_NAME,
            input: { bugs: ['b1', 'b2', 'b3'] },
          } as Anthropic.Messages.ToolUseBlock,
        ],
        'tool_use',
      ),
    );

    const result = await runAgent(
      {
        name: 'echo',
        model: 'test',
        maxTurns: 3,
        systemPrompt: 'you are a test',
        tools: [],
      },
      'hello',
      noopCtx(),
      schema,
    );

    expect(result.result).toEqual({ bugs: ['b1', 'b2', 'b3'] });
  });

  it('accepts an end-to-end call with a z.record (dynamic-key) schema', async () => {
    // z.record is another construct the old sanitizer bails on. Tool
    // input_schema accepts it; the intercept + Zod validation round-trip it
    // cleanly.
    const schema = z.object({
      metrics: z.record(z.number()),
    });

    pushReply(
      makeAssistantMessage(
        [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: STRUCTURED_OUTPUT_TOOL_NAME,
            input: { metrics: { ctr: 0.12, cpc: 0.8 } },
          } as Anthropic.Messages.ToolUseBlock,
        ],
        'tool_use',
      ),
    );

    const result = await runAgent(
      {
        name: 'echo',
        model: 'test',
        maxTurns: 3,
        systemPrompt: 'you are a test',
        tools: [],
      },
      'hello',
      noopCtx(),
      schema,
    );

    expect(result.result).toEqual({ metrics: { ctr: 0.12, cpc: 0.8 } });
  });
});

describe('runAgent — Stop-check injection when the model ends turn without calling StructuredOutput', () => {
  it('injects the correction and accepts a follow-up StructuredOutput call', async () => {
    const schema = z.object({ pillar: z.string() });

    // Turn 1: end_turn with prose (no StructuredOutput)
    pushReply(
      makeAssistantMessage(
        [
          {
            type: 'text',
            text: 'Sorry, here is a summary without the tool call.',
            citations: null,
          } as unknown as Anthropic.Messages.TextBlock,
        ],
        'end_turn',
      ),
    );
    // Turn 2: model corrects itself
    pushReply(
      makeAssistantMessage(
        [
          {
            type: 'tool_use',
            id: 'tu_2',
            name: STRUCTURED_OUTPUT_TOOL_NAME,
            input: { pillar: 'content' },
          } as Anthropic.Messages.ToolUseBlock,
        ],
        'tool_use',
      ),
    );

    const result = await runAgent(
      {
        name: 'echo',
        model: 'test',
        maxTurns: 4,
        systemPrompt: 'you are a test',
        tools: [],
      },
      'hello',
      noopCtx(),
      schema,
    );

    expect(result.result).toEqual({ pillar: 'content' });
    expect(createMessageCalls).toBe(2);
    // Second API call must have received the correction message as the final user message
    const messagesForTurn2 = capturedMessages[1]!;
    const lastMsg = messagesForTurn2[messagesForTurn2.length - 1]!;
    expect(lastMsg.role).toBe('user');
    expect(typeof lastMsg.content === 'string' && lastMsg.content).toBe(
      STRUCTURED_OUTPUT_CORRECTION,
    );
  });

  it('throws after MAX_STRUCTURED_OUTPUT_RETRIES Stop-checks', async () => {
    process.env.MAX_STRUCTURED_OUTPUT_RETRIES = '2';
    const schema = z.object({ pillar: z.string() });

    // The model keeps ending its turn with prose. With retries=2 and a
    // matching maxTurns=4 we get 3 total API calls (turn 1 -> retry 1,
    // turn 2 -> retry 2, turn 3 -> exhausted). On turn 3 runAgent throws.
    for (let i = 0; i < 4; i++) {
      pushReply(
        makeAssistantMessage(
          [
            {
              type: 'text',
              text: 'I keep forgetting.',
              citations: null,
            } as unknown as Anthropic.Messages.TextBlock,
          ],
          'end_turn',
        ),
      );
    }

    await expect(
      runAgent(
        {
          name: 'echo',
          model: 'test',
          maxTurns: 4,
          systemPrompt: 'you are a test',
          tools: [],
        },
        'hello',
        noopCtx(),
        schema,
      ),
    ).rejects.toThrow(/Stop-check retries/);
    // 1 original + 2 retries = 3 calls before throw
    expect(createMessageCalls).toBe(3);

    delete process.env.MAX_STRUCTURED_OUTPUT_RETRIES;
  });
});
