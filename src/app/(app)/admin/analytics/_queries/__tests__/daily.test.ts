import { describe, it, expect, beforeEach, vi } from 'vitest';

// 6 mock returns in the order the queries fire inside getDailyActivity
const queryReturns = vi.hoisted(() => ({
  waitlist: vi.fn(),
  signin: vi.fn(),
  scan: vi.fn(),
  draft: vi.fn(),
  post: vi.fn(),
  approval: vi.fn(),
}));

let callCount = 0;
const callOrder = ['waitlist', 'signin', 'scan', 'draft', 'post', 'approval'] as const;

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          groupBy: vi.fn(() => {
            const which = callOrder[callCount++];
            return queryReturns[which]();
          }),
        })),
      })),
    })),
  },
}));

import { getDailyActivity } from '../daily';

beforeEach(() => {
  callCount = 0;
  for (const k of callOrder) queryReturns[k].mockReset();
});

const NOW = new Date('2026-05-11T00:00:00Z');

describe('getDailyActivity', () => {
  it('returns 30-element arrays (default window) per metric', async () => {
    queryReturns.waitlist.mockResolvedValueOnce([]);
    queryReturns.signin.mockResolvedValueOnce([]);
    queryReturns.scan.mockResolvedValueOnce([]);
    queryReturns.draft.mockResolvedValueOnce([]);
    queryReturns.post.mockResolvedValueOnce([]);
    queryReturns.approval.mockResolvedValueOnce([]);

    const r = await getDailyActivity({ now: NOW, windowDays: 30 });

    expect(r.days).toHaveLength(30);
    expect(r.waitlistSignups).toHaveLength(30);
    expect(r.signins).toHaveLength(30);
    expect(r.scans).toHaveLength(30);
    expect(r.drafts).toHaveLength(30);
    expect(r.postsPublished).toHaveLength(30);
    expect(r.approvals).toHaveLength(30);
    expect(r.waitlistSignups.every((n) => n === 0)).toBe(true);
  });

  it('zips rows back into the days array by day key', async () => {
    // 2 signups on 2026-05-09 (2 days before NOW), 1 on 2026-05-06
    queryReturns.waitlist.mockResolvedValueOnce([
      { day: '2026-05-09', count: 2 },
      { day: '2026-05-06', count: 1 },
    ]);
    queryReturns.signin.mockResolvedValueOnce([]);
    queryReturns.scan.mockResolvedValueOnce([]);
    queryReturns.draft.mockResolvedValueOnce([]);
    queryReturns.post.mockResolvedValueOnce([]);
    queryReturns.approval.mockResolvedValueOnce([]);

    const r = await getDailyActivity({ now: NOW, windowDays: 30 });

    // days are oldest-first; 2026-05-09 is at index 30 - 2 - 1 = 27
    // 2026-05-06 is at index 30 - 5 - 1 = 24
    const idx9 = r.days.indexOf('2026-05-09');
    const idx6 = r.days.indexOf('2026-05-06');
    expect(idx9).toBeGreaterThan(-1);
    expect(idx6).toBeGreaterThan(-1);
    expect(r.waitlistSignups[idx9]).toBe(2);
    expect(r.waitlistSignups[idx6]).toBe(1);
  });

  it('days array is oldest-first, length matches windowDays', async () => {
    queryReturns.waitlist.mockResolvedValueOnce([]);
    queryReturns.signin.mockResolvedValueOnce([]);
    queryReturns.scan.mockResolvedValueOnce([]);
    queryReturns.draft.mockResolvedValueOnce([]);
    queryReturns.post.mockResolvedValueOnce([]);
    queryReturns.approval.mockResolvedValueOnce([]);

    const r = await getDailyActivity({ now: NOW, windowDays: 7 });
    expect(r.days).toHaveLength(7);
    // First day is 6 days before NOW = 2026-05-05
    expect(r.days[0]).toBe('2026-05-05');
    expect(r.days[6]).toBe('2026-05-11');
  });

  it('coerces string counts to numbers', async () => {
    queryReturns.waitlist.mockResolvedValueOnce([
      { day: '2026-05-09', count: '5' },
    ]);
    queryReturns.signin.mockResolvedValueOnce([]);
    queryReturns.scan.mockResolvedValueOnce([]);
    queryReturns.draft.mockResolvedValueOnce([]);
    queryReturns.post.mockResolvedValueOnce([]);
    queryReturns.approval.mockResolvedValueOnce([]);

    const r = await getDailyActivity({ now: NOW, windowDays: 30 });
    const idx = r.days.indexOf('2026-05-09');
    expect(r.waitlistSignups[idx]).toBe(5);
    expect(typeof r.waitlistSignups[idx]).toBe('number');
  });
});
