import { describe, it, expect, beforeEach, vi } from 'vitest';

const executeReturns = vi.hoisted(() => ({
  cohort: vi.fn(),
  nDay: vi.fn(),
  dauWau: vi.fn(),
}));

let callCount = 0;
const callOrder = ['cohort', 'nDay', 'dauWau'] as const;

vi.mock('@/lib/db', () => ({
  db: {
    execute: vi.fn(() => {
      const which = callOrder[callCount++];
      return executeReturns[which]();
    }),
  },
}));

import { getRetention } from '../retention';

beforeEach(() => {
  callCount = 0;
  for (const k of callOrder) executeReturns[k].mockReset();
});

describe('getRetention', () => {
  it('returns empty cohorts + zero retention when no rows', async () => {
    executeReturns.cohort.mockResolvedValueOnce([]);
    executeReturns.nDay.mockResolvedValueOnce([]);
    executeReturns.dauWau.mockResolvedValueOnce([]);

    const r = await getRetention();
    expect(r.cohorts).toEqual([]);
    expect(r.nDayRetention).toEqual({ d1: 0, d7: 0, d14: 0 });
    expect(r.dauWauRatio).toBe(0);
  });

  it('parses cohort rows and normalizes Date cohortStart to YYYY-MM-DD', async () => {
    executeReturns.cohort.mockResolvedValueOnce([
      {
        cohort_start: new Date('2026-04-27T00:00:00Z'),
        cohort_size: 5,
        w0: 5,
        w1: 3,
        w2: 2,
        w3: 1,
      },
    ]);
    executeReturns.nDay.mockResolvedValueOnce([]);
    executeReturns.dauWau.mockResolvedValueOnce([]);

    const r = await getRetention();
    expect(r.cohorts).toHaveLength(1);
    expect(r.cohorts[0].cohortStart).toBe('2026-04-27');
    expect(r.cohorts[0].cohortSize).toBe(5);
    expect(r.cohorts[0].weeklyRetention).toEqual([5, 3, 2, 1]);
  });

  it('parses cohort rows when cohort_start is already a string', async () => {
    executeReturns.cohort.mockResolvedValueOnce([
      { cohort_start: '2026-04-27', cohort_size: 5, w0: 5, w1: 0, w2: 0, w3: 0 },
    ]);
    executeReturns.nDay.mockResolvedValueOnce([]);
    executeReturns.dauWau.mockResolvedValueOnce([]);

    const r = await getRetention();
    expect(r.cohorts[0].cohortStart).toBe('2026-04-27');
  });

  it('computes nDayRetention as ratios', async () => {
    executeReturns.cohort.mockResolvedValueOnce([]);
    executeReturns.nDay.mockResolvedValueOnce([
      { e_d1: 10, r_d1: 6, e_d7: 8, r_d7: 4, e_d14: 5, r_d14: 1 },
    ]);
    executeReturns.dauWau.mockResolvedValueOnce([]);

    const r = await getRetention();
    expect(r.nDayRetention.d1).toBeCloseTo(0.6, 5);
    expect(r.nDayRetention.d7).toBeCloseTo(0.5, 5);
    expect(r.nDayRetention.d14).toBeCloseTo(0.2, 5);
  });

  it('handles zero eligible users without dividing by zero', async () => {
    executeReturns.cohort.mockResolvedValueOnce([]);
    executeReturns.nDay.mockResolvedValueOnce([
      { e_d1: 0, r_d1: 0, e_d7: 0, r_d7: 0, e_d14: 0, r_d14: 0 },
    ]);
    executeReturns.dauWau.mockResolvedValueOnce([]);

    const r = await getRetention();
    expect(r.nDayRetention).toEqual({ d1: 0, d7: 0, d14: 0 });
  });

  it('computes dauWauRatio', async () => {
    executeReturns.cohort.mockResolvedValueOnce([]);
    executeReturns.nDay.mockResolvedValueOnce([]);
    executeReturns.dauWau.mockResolvedValueOnce([{ dau: 3, wau: 10 }]);

    const r = await getRetention();
    expect(r.dauWauRatio).toBeCloseTo(0.3, 5);
  });

  it('handles wau=0 without dividing by zero', async () => {
    executeReturns.cohort.mockResolvedValueOnce([]);
    executeReturns.nDay.mockResolvedValueOnce([]);
    executeReturns.dauWau.mockResolvedValueOnce([{ dau: 0, wau: 0 }]);

    const r = await getRetention();
    expect(r.dauWauRatio).toBe(0);
  });

  it('coerces BIGINT-as-string counts to numbers', async () => {
    executeReturns.cohort.mockResolvedValueOnce([
      { cohort_start: '2026-05-04', cohort_size: '12', w0: '8', w1: '4', w2: '2', w3: '0' },
    ]);
    executeReturns.nDay.mockResolvedValueOnce([
      { e_d1: '5', r_d1: '3', e_d7: '0', r_d7: '0', e_d14: '0', r_d14: '0' },
    ]);
    executeReturns.dauWau.mockResolvedValueOnce([{ dau: '2', wau: '5' }]);

    const r = await getRetention();
    expect(r.cohorts[0].cohortSize).toBe(12);
    expect(r.cohorts[0].weeklyRetention).toEqual([8, 4, 2, 0]);
    expect(r.nDayRetention.d1).toBeCloseTo(0.6, 5);
    expect(r.dauWauRatio).toBeCloseTo(0.4, 5);
  });
});
