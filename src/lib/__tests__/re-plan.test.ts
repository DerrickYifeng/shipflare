import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every chained call the implementation makes so each test
// can assert against the conditions + set clause the helper issues.
// drizzle's builder is chainable — each method returns `this` (here,
// the mock) so we can tail-call through to `.returning()`.
const setSpy = vi.fn();
const whereSpy = vi.fn();
const returningSpy = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    update: () => ({
      set: (v: unknown) => {
        setSpy(v);
        return {
          where: (cond: unknown) => {
            whereSpy(cond);
            return {
              returning: () => returningSpy(),
            };
          },
        };
      },
    }),
  },
}));

// drizzle's sql + comparison helpers are namespace-imported by the
// module under test. We don't need to execute them — just let them
// produce serializable sentinel values so `and()` / `eq()` don't
// throw. The helpers below mimic the drizzle API shape enough that
// the production code path runs.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
  return {
    ...actual,
    sql: Object.assign(() => ({}), {
      raw: () => ({}),
    }),
  };
});

beforeEach(() => {
  setSpy.mockReset();
  whereSpy.mockReset();
  returningSpy.mockReset();
});

describe('supersedePlanItems', () => {
  it('returns the count of rows the UPDATE returned', async () => {
    returningSpy.mockReturnValueOnce([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const { supersedePlanItems } = await import('../re-plan');
    const count = await supersedePlanItems({
      userId: 'u-1',
      windowStart: new Date('2026-04-20T00:00:00Z'),
      windowEnd: new Date('2026-04-27T00:00:00Z'),
    });
    expect(count).toBe(3);
    expect(setSpy).toHaveBeenCalledTimes(1);
    const setArg = setSpy.mock.calls[0][0] as { state: string };
    expect(setArg.state).toBe('superseded');
  });

  it('returns 0 when nothing matches', async () => {
    returningSpy.mockReturnValueOnce([]);
    const { supersedePlanItems } = await import('../re-plan');
    const count = await supersedePlanItems({
      userId: 'u-2',
      windowStart: new Date('2026-04-20T00:00:00Z'),
      windowEnd: new Date('2026-04-27T00:00:00Z'),
    });
    expect(count).toBe(0);
  });

  it('rejects windowEnd <= windowStart without touching the DB', async () => {
    const { supersedePlanItems } = await import('../re-plan');
    await expect(
      supersedePlanItems({
        userId: 'u-3',
        windowStart: new Date('2026-04-27T00:00:00Z'),
        windowEnd: new Date('2026-04-20T00:00:00Z'),
      }),
    ).rejects.toThrow(/windowEnd/);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('rejects an equal windowEnd/windowStart', async () => {
    const { supersedePlanItems } = await import('../re-plan');
    const ts = new Date('2026-04-20T00:00:00Z');
    await expect(
      supersedePlanItems({
        userId: 'u-3',
        windowStart: ts,
        windowEnd: ts,
      }),
    ).rejects.toThrow();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('fires one UPDATE regardless of the optional kinds filter', async () => {
    returningSpy.mockReturnValueOnce([{ id: 'x' }]);
    const { supersedePlanItems } = await import('../re-plan');
    await supersedePlanItems({
      userId: 'u-4',
      windowStart: new Date('2026-04-20T00:00:00Z'),
      windowEnd: new Date('2026-04-27T00:00:00Z'),
      kinds: ['content_post', 'content_reply'],
    });
    expect(whereSpy).toHaveBeenCalledTimes(1);
  });
});

describe('supersedeForStrategicReplan', () => {
  it('returns the count of superseded rows', async () => {
    returningSpy.mockReturnValueOnce([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd' },
    ]);
    const { supersedeForStrategicReplan } = await import('../re-plan');
    const count = await supersedeForStrategicReplan('u-strategic');
    expect(count).toBe(4);
  });

  it('returns 0 when no pre-approval rows exist', async () => {
    returningSpy.mockReturnValueOnce([]);
    const { supersedeForStrategicReplan } = await import('../re-plan');
    const count = await supersedeForStrategicReplan('u-clean');
    expect(count).toBe(0);
  });
});
