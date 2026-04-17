import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

/**
 * Holder for the rows each UPDATE ... RETURNING should yield. The processor
 * calls `.update(xContentCalendar)` first and `.update(threads)` second, so we
 * track call order and return the matching queue entry.
 */
const updateReturns: { xcc: unknown[]; threads: unknown[] } = {
  xcc: [],
  threads: [],
};
let updateCallIdx = 0;

vi.mock('@/lib/db', () => ({
  db: {
    update: () => {
      updateCallIdx += 1;
      const isFirstCall = updateCallIdx === 1;
      return {
        set: () => ({
          where: () => ({
            returning: () =>
              Promise.resolve(
                isFirstCall ? updateReturns.xcc : updateReturns.threads,
              ),
          }),
        }),
      };
    },
  },
}));

vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  updateReturns.xcc = [];
  updateReturns.threads = [];
  updateCallIdx = 0;
});

function fakeJob(): Job<Record<string, never>> {
  return { id: 'sweep-1', data: {} } as unknown as Job<Record<string, never>>;
}

describe('processStalledRowSweep', () => {
  it('publishes one plan + one reply SSE per swept row and runs both UPDATEs', async () => {
    updateReturns.xcc = [
      { id: 'ci-1', userId: 'u-1' },
      { id: 'ci-2', userId: 'u-2' },
    ];
    updateReturns.threads = [{ id: 'th-1', userId: 'u-3' }];

    const { processStalledRowSweep } = await import('../stalled-row-sweep');
    const { publishUserEvent } = await import('@/lib/redis');

    await processStalledRowSweep(fakeJob());

    // Both UPDATEs fired (xcc + threads = 2 calls tracked by updateCallIdx).
    expect(updateCallIdx).toBe(2);

    // 2 plan + 1 reply = 3 SSE events.
    expect(publishUserEvent).toHaveBeenCalledTimes(3);

    // Plan events on 'agents' channel, reply events on 'drafts' channel.
    expect(publishUserEvent).toHaveBeenCalledWith(
      'u-1',
      'agents',
      expect.objectContaining({
        type: 'pipeline',
        pipeline: 'plan',
        itemId: 'ci-1',
        state: 'failed',
        data: { reason: 'drafting_timeout' },
      }),
    );
    expect(publishUserEvent).toHaveBeenCalledWith(
      'u-2',
      'agents',
      expect.objectContaining({
        pipeline: 'plan',
        itemId: 'ci-2',
        state: 'failed',
      }),
    );
    expect(publishUserEvent).toHaveBeenCalledWith(
      'u-3',
      'drafts',
      expect.objectContaining({
        type: 'pipeline',
        pipeline: 'reply',
        itemId: 'th-1',
        state: 'failed',
        data: { reason: 'drafting_timeout' },
      }),
    );
  });

  it('publishes nothing when nothing is swept', async () => {
    updateReturns.xcc = [];
    updateReturns.threads = [];

    const { processStalledRowSweep } = await import('../stalled-row-sweep');
    const { publishUserEvent } = await import('@/lib/redis');

    await processStalledRowSweep(fakeJob());

    // Both UPDATEs still execute (the filter handles the no-rows case in SQL).
    expect(updateCallIdx).toBe(2);
    expect(publishUserEvent).not.toHaveBeenCalled();
  });

  it('handles mixed empty/populated tables', async () => {
    updateReturns.xcc = [];
    updateReturns.threads = [
      { id: 'th-a', userId: 'u-a' },
      { id: 'th-b', userId: 'u-b' },
    ];

    const { processStalledRowSweep } = await import('../stalled-row-sweep');
    const { publishUserEvent } = await import('@/lib/redis');

    await processStalledRowSweep(fakeJob());

    expect(publishUserEvent).toHaveBeenCalledTimes(2);
    // Both on 'drafts' channel, pipeline='reply'.
    const calls = (publishUserEvent as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    for (const call of calls) {
      expect(call[1]).toBe('drafts');
      expect(call[2]).toMatchObject({ pipeline: 'reply', state: 'failed' });
    }
  });
});
