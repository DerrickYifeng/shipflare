import { describe, it, expect, vi } from 'vitest';
import { loadAgentRunHistory } from '@/workers/processors/lib/agent-run-history';

interface MockHistoryRow {
  id: string;
  fromAgentId: string | null;
  toAgentId: string | null;
  type: string;
  messageType: string;
  content: string | null;
  createdAt: Date;
}

// Lightweight db mock: enough surface for loadAgentRunHistory's
// select().from().where().orderBy() chain.
function makeDb(rows: MockHistoryRow[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(async () => rows),
        })),
      })),
    })),
  };
}

describe('loadAgentRunHistory', () => {
  it('returns empty array when no history', async () => {
    const db = makeDb([]);
    const result = await loadAgentRunHistory('agent-1', db as never);
    expect(result).toEqual([]);
  });

  it("maps fromAgentId=self → assistant role (agent's prior turn)", async () => {
    const db = makeDb([
      {
        id: 'm1',
        fromAgentId: 'agent-1',
        toAgentId: null,
        type: 'agent_text',
        messageType: 'message',
        content: 'I drafted 3 replies',
        createdAt: new Date('2026-05-02T00:00:00Z'),
      },
    ]);
    const result = await loadAgentRunHistory('agent-1', db as never);
    expect(result).toEqual([
      { role: 'assistant', content: 'I drafted 3 replies' },
    ]);
  });

  it('maps toAgentId=self → user role (incoming message)', async () => {
    const db = makeDb([
      {
        id: 'm1',
        fromAgentId: null,
        toAgentId: 'agent-1',
        type: 'user_prompt',
        messageType: 'message',
        content: 'Continue the work',
        createdAt: new Date('2026-05-02T00:00:00Z'),
      },
    ]);
    const result = await loadAgentRunHistory('agent-1', db as never);
    expect(result).toEqual([
      { role: 'user', content: 'Continue the work' },
    ]);
  });

  it('orders by createdAt ascending', async () => {
    const db = makeDb([
      {
        id: 'm1',
        fromAgentId: null,
        toAgentId: 'agent-1',
        type: 'user_prompt',
        messageType: 'message',
        content: 'first',
        createdAt: new Date('2026-05-02T00:00:00Z'),
      },
      {
        id: 'm2',
        fromAgentId: 'agent-1',
        toAgentId: null,
        type: 'agent_text',
        messageType: 'message',
        content: 'second',
        createdAt: new Date('2026-05-02T00:00:01Z'),
      },
      {
        id: 'm3',
        fromAgentId: null,
        toAgentId: 'agent-1',
        type: 'user_prompt',
        messageType: 'message',
        content: 'third',
        createdAt: new Date('2026-05-02T00:00:02Z'),
      },
    ]);
    const result = await loadAgentRunHistory('agent-1', db as never);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: 'user', content: 'first' });
    expect(result[1]).toEqual({ role: 'assistant', content: 'second' });
    expect(result[2]).toEqual({ role: 'user', content: 'third' });
  });

  it('skips rows with null content', async () => {
    const db = makeDb([
      {
        id: 'm1',
        fromAgentId: 'agent-1',
        toAgentId: null,
        type: 'agent_text',
        messageType: 'message',
        content: null,
        createdAt: new Date(),
      },
    ]);
    const result = await loadAgentRunHistory('agent-1', db as never);
    expect(result).toEqual([]);
  });
});
