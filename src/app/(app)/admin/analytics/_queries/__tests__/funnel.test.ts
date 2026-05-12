import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted mock returns — one per query in the Promise.all
const queryReturns = vi.hoisted(() => ({
  waitlist: vi.fn(),
  approved: vi.fn(),
  signedUp: vi.fn(),
  scans: vi.fn(),
  posts: vi.fn(),
}));

let callCount = 0;
const callOrder = ['waitlist', 'approved', 'signedUp', 'scans', 'posts'] as const;

// Mock db.select to return values in the order they're called within getFunnel
vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const which = callOrder[callCount++];
          return queryReturns[which]();
        }),
      })),
    })),
  },
}));

import { getFunnel } from '../funnel';

beforeEach(() => {
  callCount = 0;
  for (const k of callOrder) queryReturns[k].mockReset();
});

describe('getFunnel', () => {
  it('returns counts from the five aggregate queries', async () => {
    queryReturns.waitlist.mockResolvedValueOnce([{ count: 10 }]);
    queryReturns.approved.mockResolvedValueOnce([{ count: 7 }]);
    queryReturns.signedUp.mockResolvedValueOnce([{ count: 5 }]);
    queryReturns.scans.mockResolvedValueOnce([{ count: 4 }]);
    queryReturns.posts.mockResolvedValueOnce([{ count: 2 }]);

    const result = await getFunnel({ windowDays: 30 });

    expect(result).toEqual({
      waitlistSignups: 10,
      approvedAllowlisted: 7,
      signedUp: 5,
      ranFirstScan: 4,
      publishedFirstPost: 2,
    });
  });

  it('coerces string counts (Postgres BIGINT) to numbers', async () => {
    queryReturns.waitlist.mockResolvedValueOnce([{ count: '99' }]);
    queryReturns.approved.mockResolvedValueOnce([{ count: '0' }]);
    queryReturns.signedUp.mockResolvedValueOnce([{ count: 0 }]);
    queryReturns.scans.mockResolvedValueOnce([{ count: 0 }]);
    queryReturns.posts.mockResolvedValueOnce([{ count: 0 }]);

    const result = await getFunnel();
    expect(result.waitlistSignups).toBe(99);
    expect(typeof result.waitlistSignups).toBe('number');
  });

  it('uses 30-day window by default', async () => {
    queryReturns.waitlist.mockResolvedValueOnce([{ count: 1 }]);
    queryReturns.approved.mockResolvedValueOnce([{ count: 1 }]);
    queryReturns.signedUp.mockResolvedValueOnce([{ count: 1 }]);
    queryReturns.scans.mockResolvedValueOnce([{ count: 1 }]);
    queryReturns.posts.mockResolvedValueOnce([{ count: 1 }]);

    const result = await getFunnel();
    expect(result.waitlistSignups).toBe(1);
  });

  it('handles empty results', async () => {
    queryReturns.waitlist.mockResolvedValueOnce([{ count: 0 }]);
    queryReturns.approved.mockResolvedValueOnce([{ count: 0 }]);
    queryReturns.signedUp.mockResolvedValueOnce([{ count: 0 }]);
    queryReturns.scans.mockResolvedValueOnce([{ count: 0 }]);
    queryReturns.posts.mockResolvedValueOnce([{ count: 0 }]);

    const result = await getFunnel();
    expect(result).toEqual({
      waitlistSignups: 0,
      approvedAllowlisted: 0,
      signedUp: 0,
      ranFirstScan: 0,
      publishedFirstPost: 0,
    });
  });
});
