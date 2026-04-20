import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let activePaths: Array<{ userId: string; productId: string; pathId: string }> = [];

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve(activePaths),
        }),
      }),
    }),
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
  return { ...actual, eq: () => ({}) };
});

const lockResults = new Map<string, boolean>();
const kvSetMock = vi.fn(async (key: string) => {
  const allow = lockResults.get(key) ?? true;
  return allow ? 'OK' : null;
});
vi.mock('@/lib/redis', () => ({
  getKeyValueClient: () => ({ set: kvSetMock }),
}));

const runTacticalReplanMock = vi.fn();
vi.mock('@/lib/re-plan', () => ({
  runTacticalReplan: (userId: string, trigger: string) =>
    runTacticalReplanMock(userId, trigger),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
  loggerForJob: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeJob(): Job<Record<string, never>> {
  return { id: 'cron-job', name: 'weekly-replan', data: {} } as unknown as Job<
    Record<string, never>
  >;
}

beforeEach(() => {
  activePaths = [];
  lockResults.clear();
  kvSetMock.mockClear();
  runTacticalReplanMock.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processWeeklyReplan', () => {
  it('is a no-op when no users have active strategic paths', async () => {
    activePaths = [];
    const { processWeeklyReplan } = await import('../weekly-replan');
    await processWeeklyReplan(fakeJob());
    expect(runTacticalReplanMock).not.toHaveBeenCalled();
  });

  it('calls runTacticalReplan with trigger=weekly for each active user', async () => {
    activePaths = [
      { userId: 'u-1', productId: 'p-1', pathId: 'sp-1' },
      { userId: 'u-2', productId: 'p-2', pathId: 'sp-2' },
    ];
    runTacticalReplanMock.mockResolvedValue({
      ok: true,
      plan: { plan: { notes: null }, items: [] },
      itemsInserted: 3,
      itemsSuperseded: 1,
    });
    const { processWeeklyReplan } = await import('../weekly-replan');
    await processWeeklyReplan(fakeJob());
    expect(runTacticalReplanMock).toHaveBeenCalledTimes(2);
    expect(runTacticalReplanMock).toHaveBeenCalledWith('u-1', 'weekly');
    expect(runTacticalReplanMock).toHaveBeenCalledWith('u-2', 'weekly');
  });

  it('skips users whose per-week lock is already held', async () => {
    activePaths = [
      { userId: 'u-1', productId: 'p-1', pathId: 'sp-1' },
      { userId: 'u-2', productId: 'p-2', pathId: 'sp-2' },
    ];
    // Let u-1 run; block u-2 at the lock
    lockResults.set('replan:u-2:', false);
    // But the lock key includes the week — we just reject any key that
    // contains 'u-2' by matching against the actual set() call.
    kvSetMock.mockImplementationOnce(async () => 'OK');
    kvSetMock.mockImplementationOnce(async () => null);

    runTacticalReplanMock.mockResolvedValue({
      ok: true,
      plan: { plan: { notes: null }, items: [] },
      itemsInserted: 1,
      itemsSuperseded: 0,
    });
    const { processWeeklyReplan } = await import('../weekly-replan');
    await processWeeklyReplan(fakeJob());
    // Only u-1 should have triggered runTacticalReplan — u-2 was locked
    expect(runTacticalReplanMock).toHaveBeenCalledTimes(1);
    expect(runTacticalReplanMock).toHaveBeenCalledWith('u-1', 'weekly');
  });

  it('continues processing the batch when one user crashes', async () => {
    activePaths = [
      { userId: 'u-1', productId: 'p-1', pathId: 'sp-1' },
      { userId: 'u-2', productId: 'p-2', pathId: 'sp-2' },
      { userId: 'u-3', productId: 'p-3', pathId: 'sp-3' },
    ];
    runTacticalReplanMock
      .mockResolvedValueOnce({
        ok: true,
        plan: { plan: { notes: null }, items: [] },
        itemsInserted: 2,
        itemsSuperseded: 0,
      })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        ok: true,
        plan: { plan: { notes: null }, items: [] },
        itemsInserted: 4,
        itemsSuperseded: 1,
      });
    const { processWeeklyReplan } = await import('../weekly-replan');
    await processWeeklyReplan(fakeJob());
    // All three users were attempted
    expect(runTacticalReplanMock).toHaveBeenCalledTimes(3);
  });

  it('continues when runTacticalReplan returns a soft-failure', async () => {
    activePaths = [
      { userId: 'u-1', productId: 'p-1', pathId: 'sp-1' },
      { userId: 'u-2', productId: 'p-2', pathId: 'sp-2' },
    ];
    runTacticalReplanMock
      .mockResolvedValueOnce({ ok: false, code: 'no_active_path' })
      .mockResolvedValueOnce({
        ok: true,
        plan: { plan: { notes: null }, items: [] },
        itemsInserted: 1,
        itemsSuperseded: 0,
      });
    const { processWeeklyReplan } = await import('../weekly-replan');
    await processWeeklyReplan(fakeJob());
    expect(runTacticalReplanMock).toHaveBeenCalledTimes(2);
  });
});
