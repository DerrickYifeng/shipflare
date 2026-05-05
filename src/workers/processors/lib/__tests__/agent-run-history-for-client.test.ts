// Test suite for loadAgentRunHistoryRedactedForClient — the client-safe
// variant of loadAgentRunHistory used by the transcript route.
//
// The mock pattern mirrors the original agent-run-history.test.ts:
// a chainable select().from().where().orderBy() stub. We verify that
// the redaction pipeline in redact-for-client is composed correctly
// without re-testing its internals (those have their own suite).

import { describe, it, expect, vi } from 'vitest';
import { loadAgentRunHistoryRedactedForClient } from '@/workers/processors/lib/agent-run-history-for-client';

interface MockHistoryRow {
  fromAgentId: string | null;
  toAgentId: string | null;
  content: string | null;
  contentBlocks: unknown;
  metadata: Record<string, unknown> | null;
}

function makeDb(rows: MockHistoryRow[]) {
  const orderBy = vi.fn(async () => rows);
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    db: { select } as unknown,
    spies: { select, from, where, orderBy },
  };
}

describe('loadAgentRunHistoryRedactedForClient', () => {
  it('redacts tool_use blocks inside contentBlocks (assistant turn)', async () => {
    const { db } = makeDb([
      {
        fromAgentId: 'agent-1',
        toAgentId: null,
        content: null,
        contentBlocks: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'find_threads_via_xai',
            input: { query: 'leak me' },
          },
        ],
        metadata: null,
      },
    ]);

    const messages = await loadAgentRunHistoryRedactedForClient(
      'agent-1',
      db as never,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'searching', input: {} },
    ]);

    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain('xai');
    expect(serialized).not.toContain('leak me');
    expect(serialized).not.toContain('find_threads_via_xai');
  });

  it('swaps content with metadata.publicContent for kickoff user_prompt', async () => {
    const { db } = makeDb([
      {
        fromAgentId: null,
        toAgentId: 'agent-1',
        content:
          'First-visit kickoff for Acme. Strategic path... Follow your kickoff playbook end-to-end (plan → social-media-manager): ...',
        contentBlocks: null,
        metadata: {
          trigger: 'kickoff',
          publicContent:
            'Setting up your week-1 plan and content for Acme.',
        },
      },
    ]);

    const messages = await loadAgentRunHistoryRedactedForClient(
      'agent-1',
      db as never,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      role: 'user',
      content: 'Setting up your week-1 plan and content for Acme.',
    });

    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain('social-media-manager');
    expect(serialized).not.toContain('playbook');
    expect(serialized).not.toContain('kickoff playbook end-to-end');
  });

  it('passes plain text content through unchanged', async () => {
    const { db } = makeDb([
      {
        fromAgentId: null,
        toAgentId: 'agent-1',
        content: 'Hey team, what should I post today?',
        contentBlocks: null,
        metadata: null,
      },
    ]);

    const messages = await loadAgentRunHistoryRedactedForClient(
      'agent-1',
      db as never,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      role: 'user',
      content: 'Hey team, what should I post today?',
    });
  });

  it('skips rows with null content AND null contentBlocks', async () => {
    const { db } = makeDb([
      {
        fromAgentId: 'agent-1',
        toAgentId: null,
        content: null,
        contentBlocks: null,
        metadata: null,
      },
      {
        fromAgentId: 'agent-1',
        toAgentId: null,
        content: 'I drafted 3 replies',
        contentBlocks: null,
        metadata: null,
      },
    ]);

    const messages = await loadAgentRunHistoryRedactedForClient(
      'agent-1',
      db as never,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      role: 'assistant',
      content: 'I drafted 3 replies',
    });
  });

  it('maps roles correctly based on fromAgentId vs toAgentId', async () => {
    const { db } = makeDb([
      {
        fromAgentId: 'agent-1',
        toAgentId: null,
        content: 'agent says hi',
        contentBlocks: null,
        metadata: null,
      },
      {
        fromAgentId: null,
        toAgentId: 'agent-1',
        content: 'user says hi',
        contentBlocks: null,
        metadata: null,
      },
    ]);

    const messages = await loadAgentRunHistoryRedactedForClient(
      'agent-1',
      db as never,
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: 'assistant',
      content: 'agent says hi',
    });
    expect(messages[1]).toEqual({
      role: 'user',
      content: 'user says hi',
    });
  });

  it('queries with the chained select/from/where/orderBy shape', async () => {
    const { db, spies } = makeDb([]);

    await loadAgentRunHistoryRedactedForClient('agent-1', db as never);

    expect(spies.select).toHaveBeenCalledTimes(1);
    expect(spies.from).toHaveBeenCalledTimes(1);
    expect(spies.where).toHaveBeenCalledTimes(1);
    expect(spies.orderBy).toHaveBeenCalledTimes(1);
  });
});
