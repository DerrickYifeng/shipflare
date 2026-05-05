import { describe, it, expect, vi, beforeEach } from 'vitest';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

type AggregateRow = {
  todayAwaiting: number;
  todayShipped: number;
  todaySkipped: number;
  yesterdayShipped: number;
  yesterdaySkipped: number;
  weekQueued: number;
  weekShipped: number;
};

let aggregateRow: AggregateRow = {
  todayAwaiting: 0,
  todayShipped: 0,
  todaySkipped: 0,
  yesterdayShipped: 0,
  yesterdaySkipped: 0,
  weekQueued: 0,
  weekShipped: 0,
};
let onboardingCompletedAt: Date | null = null;

vi.mock('@/lib/db', () => {
  const builder = {
    from: () => builder,
    where: () => builder,
    limit: () => Promise.resolve([{ onboardingCompletedAt }]),
    then: (cb: (rows: AggregateRow[]) => unknown) => cb([aggregateRow]),
  };
  return {
    db: {
      select: () => builder,
    },
  };
});

import { GET } from '../summary/route';

beforeEach(() => {
  authUserId = 'user-1';
  onboardingCompletedAt = null;
  aggregateRow = {
    todayAwaiting: 0,
    todayShipped: 0,
    todaySkipped: 0,
    yesterdayShipped: 0,
    yesterdaySkipped: 0,
    weekQueued: 0,
    weekShipped: 0,
  };
});

describe('GET /api/briefing/summary', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns zeroed summary for a user with no plan_items', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      today: { awaiting: 0, shipped: 0, skipped: 0 },
      yesterday: { shipped: 0, skipped: 0 },
      thisWeek: { totalQueued: 0, totalShipped: 0 },
      isDay1: false,
      nextDiscoveryAt: null,
    });
  });

  it('passes aggregate counts straight through', async () => {
    aggregateRow = {
      todayAwaiting: 1,
      todayShipped: 2,
      todaySkipped: 1,
      yesterdayShipped: 3,
      yesterdaySkipped: 0,
      weekQueued: 6,
      weekShipped: 4,
    };
    const res = await GET();
    const body = await res.json();
    expect(body.today).toEqual({ awaiting: 1, shipped: 2, skipped: 1 });
    expect(body.yesterday).toEqual({ shipped: 3, skipped: 0 });
    expect(body.thisWeek).toEqual({ totalQueued: 6, totalShipped: 4 });
  });

  it('flags isDay1 when onboardingCompletedAt is within 24h', async () => {
    onboardingCompletedAt = new Date(Date.now() - 60 * 60 * 1000);
    const res = await GET();
    const body = await res.json();
    expect(body.isDay1).toBe(true);
  });

  it('does not flag isDay1 once 24h have elapsed', async () => {
    onboardingCompletedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const res = await GET();
    const body = await res.json();
    expect(body.isDay1).toBe(false);
  });
});
