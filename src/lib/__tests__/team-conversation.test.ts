import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

const hoisted = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    teamId: string;
    runId: string | null;
    conversationId: string | null;
    fromMemberId: string | null;
    toMemberId: string | null;
    type: string;
    content: string | null;
    metadata: unknown;
    createdAt: Date;
  }>,
  lastWhere: null as unknown,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

vi.mock('@/lib/db/schema', () => ({
  teamMessages: {
    id: 'id',
    teamId: 'teamId',
    runId: 'runId',
    conversationId: 'conversationId',
    fromMemberId: 'fromMemberId',
    toMemberId: 'toMemberId',
    type: 'type',
    content: 'content',
    metadata: 'metadata',
    createdAt: 'createdAt',
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
  return { ...actual, and: () => ({}), asc: () => ({}), eq: () => ({}), isNull: () => ({}), ne: () => ({}) };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          hoisted.lastWhere = w;
          return {
            orderBy: async () => hoisted.rows,
          };
        },
      }),
    }),
  },
}));

import { loadConversationHistory } from '../team-conversation';

function makeRow(partial: Partial<(typeof hoisted.rows)[number]> & { type: string }) {
  const now = Date.now();
  return {
    id: `m-${Math.random()}`,
    teamId: 'team-1',
    runId: null,
    conversationId: null,
    fromMemberId: null,
    toMemberId: null,
    content: null,
    metadata: null,
    createdAt: new Date(now + (hoisted.rows.length * 1000)),
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadConversationHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.rows.length = 0;
    hoisted.lastWhere = null;
  });

  it('returns empty array when no messages exist', async () => {
    const messages = await loadConversationHistory('team-1', {
      conversationId: 'conv-1',
    });
    expect(messages).toEqual([]);
  });

  it('emits user → assistant for a plain user_prompt / completion pair', async () => {
    hoisted.rows.push(
      makeRow({ type: 'user_prompt', content: 'Hi there' }),
      makeRow({ type: 'completion', content: 'Hello!' }),
    );
    const messages = await loadConversationHistory('team-1', {
      conversationId: 'conv-1',
    });
    expect(messages).toEqual([
      { role: 'user', content: 'Hi there' },
      { role: 'assistant', content: 'Hello!' },
    ]);
  });

  it('groups tool_call + tool_result with matching ids across roles', async () => {
    hoisted.rows.push(
      makeRow({ type: 'user_prompt', content: 'do X' }),
      makeRow({
        type: 'tool_call',
        metadata: { toolName: 'Task', toolUseId: 'tu-1', input: { foo: 1 } },
      }),
      makeRow({
        type: 'tool_result',
        content: 'tool returned',
        metadata: { toolUseId: 'tu-1' },
      }),
      makeRow({ type: 'completion', content: 'done' }),
    );

    const messages = await loadConversationHistory('team-1', {
      conversationId: 'conv-1',
    });

    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: 'user', content: 'do X' });

    const assistantWithToolUse = messages[1] as Anthropic.Messages.MessageParam;
    expect(assistantWithToolUse.role).toBe('assistant');
    expect(Array.isArray(assistantWithToolUse.content)).toBe(true);
    const toolUseBlock = (assistantWithToolUse.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>)[0];
    expect(toolUseBlock?.type).toBe('tool_use');
    expect(toolUseBlock?.id).toBe('tu-1');
    expect(toolUseBlock?.name).toBe('Task');

    const userWithToolResult = messages[2] as Anthropic.Messages.MessageParam;
    expect(userWithToolResult.role).toBe('user');
    const toolResultBlock = (userWithToolResult.content as Array<{ type: string; tool_use_id?: string; content?: string }>)[0];
    expect(toolResultBlock?.type).toBe('tool_result');
    expect(toolResultBlock?.tool_use_id).toBe('tu-1');

    expect(messages[3]).toEqual({ role: 'assistant', content: 'done' });
  });

  it('groups parallel tool_calls from one assistant turn into ONE message', async () => {
    hoisted.rows.push(
      makeRow({ type: 'user_prompt', content: 'do X and Y' }),
      makeRow({
        type: 'tool_call',
        metadata: { toolName: 'ToolA', toolUseId: 'tu-a', input: {} },
      }),
      makeRow({
        type: 'tool_call',
        metadata: { toolName: 'ToolB', toolUseId: 'tu-b', input: {} },
      }),
      makeRow({
        type: 'tool_result',
        content: 'A done',
        metadata: { toolUseId: 'tu-a' },
      }),
      makeRow({
        type: 'tool_result',
        content: 'B done',
        metadata: { toolUseId: 'tu-b' },
      }),
      makeRow({ type: 'completion', content: 'both done' }),
    );

    const messages = await loadConversationHistory('team-1', {
      conversationId: 'conv-1',
    });

    expect(messages).toHaveLength(4);
    const assistantMsg = messages[1] as Anthropic.Messages.MessageParam;
    expect((assistantMsg.content as Array<unknown>).length).toBe(2);

    const userMsg = messages[2] as Anthropic.Messages.MessageParam;
    expect((userMsg.content as Array<unknown>).length).toBe(2);
  });

  it('drops messages belonging to subagents (parentTaskId set)', async () => {
    hoisted.rows.push(
      makeRow({ type: 'user_prompt', content: 'ask coordinator' }),
      // Coordinator-scope Task call
      makeRow({
        type: 'tool_call',
        metadata: {
          toolName: 'Task',
          toolUseId: 'tu-task',
          input: { subagent_type: 'scout' },
        },
      }),
      // INSIDE scout's scope — should be dropped
      makeRow({
        type: 'tool_call',
        metadata: {
          toolName: 'xai_find_customers',
          toolUseId: 'tu-internal',
          input: {},
          parentTaskId: 'parent-1',
        },
      }),
      makeRow({
        type: 'tool_result',
        content: 'scout internal result',
        metadata: {
          toolUseId: 'tu-internal',
          parentTaskId: 'parent-1',
        },
      }),
      // Coordinator sees the Task's final tool_result
      makeRow({
        type: 'tool_result',
        content: '{scout summary}',
        metadata: { toolUseId: 'tu-task' },
      }),
      makeRow({ type: 'completion', content: 'done' }),
    );

    const messages = await loadConversationHistory('team-1', {
      conversationId: 'conv-1',
    });

    // user + assistant(Task) + user(result) + assistant(text) = 4
    expect(messages).toHaveLength(4);
    const assistantMsg = messages[1] as Anthropic.Messages.MessageParam;
    const toolUseBlocks = (assistantMsg.content as Array<{ type: string; name?: string }>).filter(
      (b) => b.type === 'tool_use',
    );
    expect(toolUseBlocks).toHaveLength(1);
    expect(toolUseBlocks[0]?.name).toBe('Task');
  });

  it('synthesizes an error tool_result for orphan tool_use (crashed run)', async () => {
    hoisted.rows.push(
      makeRow({ type: 'user_prompt', content: 'do X' }),
      makeRow({
        type: 'tool_call',
        metadata: { toolName: 'ToolA', toolUseId: 'tu-orphan', input: {} },
      }),
      // No matching tool_result — simulates worker crash mid-tool.
      makeRow({ type: 'user_prompt', content: 'still there?' }),
    );

    const messages = await loadConversationHistory('team-1', {
      conversationId: 'conv-1',
    });

    // user + assistant(tool_use) + SYNTHESIZED user(tool_result) + user(new prompt) = 4
    expect(messages).toHaveLength(4);
    const synthesized = messages[2] as Anthropic.Messages.MessageParam;
    expect(synthesized.role).toBe('user');
    const block = (synthesized.content as Array<{ type: string; is_error?: boolean }>)[0];
    expect(block?.type).toBe('tool_result');
    expect(block?.is_error).toBe(true);
  });

  it('drops malformed tool_calls missing toolUseId or toolName', async () => {
    hoisted.rows.push(
      makeRow({ type: 'user_prompt', content: 'hi' }),
      makeRow({ type: 'tool_call', metadata: { toolName: 'X' } }), // no toolUseId
      makeRow({ type: 'tool_call', metadata: { toolUseId: 'abc' } }), // no toolName
      makeRow({ type: 'completion', content: 'ok' }),
    );

    const messages = await loadConversationHistory('team-1', {
      conversationId: 'conv-1',
    });

    // user + assistant(just "ok") = 2
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: 'assistant', content: 'ok' });
  });

  it('drops tool_results whose tool_use_id was never declared in history', async () => {
    // Scenario: tool_call was emitted with parentTaskId set (subagent
    // scope, filtered out by isCoordinatorScope), but the tool_result
    // row was written WITHOUT parentTaskId — leaving an orphan
    // result whose tool_use the loader never saw. If we let it
    // through, Anthropic returns 400 "unexpected tool_use_id in
    // tool_result".
    hoisted.rows.push(
      makeRow({ type: 'user_prompt', content: 'hi' }),
      makeRow({
        type: 'tool_call',
        metadata: {
          toolName: 'xai_find_customers',
          toolUseId: 'tu-orphan-result',
          input: {},
          parentTaskId: 'parent-1', // filtered out
        },
      }),
      makeRow({
        type: 'tool_result',
        content: 'ghost result',
        metadata: { toolUseId: 'tu-orphan-result' }, // no parentTaskId — slips through
      }),
      makeRow({ type: 'completion', content: 'done' }),
    );

    const messages = await loadConversationHistory('team-1', {
      conversationId: 'conv-1',
    });

    // Only [user, assistant("done")] — orphan tool_result must NOT
    // appear in the assembled history.
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'user', content: 'hi' });
    expect(messages[1]).toEqual({ role: 'assistant', content: 'done' });
  });

  it('never leaves the history starting with an assistant message after trim', async () => {
    hoisted.rows.push(
      makeRow({ type: 'user_prompt', content: 'a'.repeat(400) }),
      makeRow({ type: 'completion', content: 'b'.repeat(400) }),
      makeRow({ type: 'user_prompt', content: 'c'.repeat(50) }),
      makeRow({ type: 'completion', content: 'd'.repeat(50) }),
    );

    const messages = await loadConversationHistory('team-1', {
      conversationId: 'conv-1',
      tokenBudget: 100, // forces the front to be trimmed
    });

    if (messages.length > 0) {
      expect(messages[0]?.role).toBe('user');
    }
  });

  it('trims oldest messages to fit the token budget', async () => {
    // Two large completions that blow past a tiny budget
    hoisted.rows.push(
      makeRow({ type: 'user_prompt', content: 'a'.repeat(400) }),
      makeRow({ type: 'completion', content: 'b'.repeat(400) }),
      makeRow({ type: 'user_prompt', content: 'c'.repeat(400) }),
      makeRow({ type: 'completion', content: 'd'.repeat(400) }),
    );

    const messages = await loadConversationHistory('team-1', {
      conversationId: 'conv-1',
      tokenBudget: 150, // tiny
    });

    // Expect only the most recent turn(s) to survive
    expect(messages.length).toBeLessThan(4);
    if (messages.length > 0) {
      const last = messages[messages.length - 1] as Anthropic.Messages.MessageParam;
      // Last surviving message should be the newest 'completion'
      if (typeof last.content === 'string') {
        expect(last.content).toBe('d'.repeat(400));
      }
    }
  });
});
