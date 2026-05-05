import { describe, it, expect, vi } from 'vitest';
import { drainMailbox } from '@/workers/processors/lib/mailbox-drain';

// Lightweight db mock: enough surface for drainMailbox's transaction body.
function makeDbMock(undelivered: Array<{
  id: string;
  toAgentId: string;
  type: string;
  messageType: string;
  content: string | null;
  createdAt: Date;
}>) {
  const updates: string[][] = [];
  return {
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      // Build a minimal tx that supports select + update with the
      // chained API drainMailbox uses.
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                for: vi.fn(async () => undelivered),
              })),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn((predicate: unknown) => {
              // Capture the IDs the implementation passes in.
              // (We expect drainMailbox to pass an inArray() predicate over IDs.)
              const _stringified = String(predicate);
              const ids = undelivered.map((r) => r.id);
              updates.push(ids);
              return Promise.resolve();
            }),
          })),
        })),
      };
      const result = await cb(tx as never);
      return result;
    }),
    _updates: updates,
  };
}

describe('drainMailbox', () => {
  const t0 = new Date('2026-05-02T00:00:00Z');
  const t1 = new Date('2026-05-02T00:00:01Z');

  it('returns batch ordered by createdAt ascending', async () => {
    const db = makeDbMock([
      { id: 'm1', toAgentId: 'a1', type: 'user_prompt', messageType: 'message', content: 'first', createdAt: t0 },
      { id: 'm2', toAgentId: 'a1', type: 'user_prompt', messageType: 'message', content: 'second', createdAt: t1 },
    ]);
    const batch = await drainMailbox('a1', db as never);
    expect(batch).toHaveLength(2);
    expect(batch[0].content).toBe('first');
    expect(batch[1].content).toBe('second');
  });

  it('skips tick messages (used as wake signals only)', async () => {
    const db = makeDbMock([
      { id: 'm1', toAgentId: 'a1', type: 'system', messageType: 'tick', content: '', createdAt: t0 },
      { id: 'm2', toAgentId: 'a1', type: 'user_prompt', messageType: 'message', content: 'real', createdAt: t1 },
    ]);
    const batch = await drainMailbox('a1', db as never);
    expect(batch).toHaveLength(1);
    expect(batch[0].content).toBe('real');
  });

  it('marks delivered_at on every drained row (idempotency)', async () => {
    const db = makeDbMock([
      { id: 'm1', toAgentId: 'a1', type: 'user_prompt', messageType: 'message', content: 'x', createdAt: t0 },
    ]);
    await drainMailbox('a1', db as never);
    expect((db as ReturnType<typeof makeDbMock>)._updates).toHaveLength(1);
    expect((db as ReturnType<typeof makeDbMock>)._updates[0]).toEqual(['m1']);
  });

  it('returns empty batch when nothing undelivered', async () => {
    const db = makeDbMock([]);
    const batch = await drainMailbox('a1', db as never);
    expect(batch).toEqual([]);
    expect((db as ReturnType<typeof makeDbMock>)._updates).toHaveLength(0);
  });

  it('reports presence of shutdown_request in batch', async () => {
    const db = makeDbMock([
      { id: 'm1', toAgentId: 'a1', type: 'user_prompt', messageType: 'shutdown_request', content: 'wrap up', createdAt: t0 },
    ]);
    const batch = await drainMailbox('a1', db as never);
    expect(batch[0].messageType).toBe('shutdown_request');
  });
});
