import { describe, it, expect, beforeEach, vi } from 'vitest';

const dbSelectReturn = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => dbSelectReturn()),
        })),
      })),
    })),
  },
}));

const activityCountsMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/admin/partner-activity', () => ({
  getPartnerActivityCounts: activityCountsMock,
}));

import { getActiveUsers } from '../users';

const NOW = new Date('2026-05-11T00:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86400_000);

beforeEach(() => {
  dbSelectReturn.mockReset();
  activityCountsMock.mockReset();
  activityCountsMock.mockResolvedValue(new Map());
});

describe('getActiveUsers', () => {
  it('returns empty when no rows match the window', async () => {
    dbSelectReturn.mockResolvedValueOnce([]);
    const rows = await getActiveUsers({ now: NOW, windowDays: 30 });
    expect(rows).toEqual([]);
  });

  it('classifies users with recent meaningful action as active', async () => {
    dbSelectReturn.mockResolvedValueOnce([
      {
        userId: 'u1',
        email: 'a@x.com',
        createdAt: ago(10),
        lastLoginAt: ago(1),
      },
    ]);
    activityCountsMock.mockResolvedValueOnce(
      new Map([['u1', { posts7d: 1, replies7d: 0, scans7d: 0 }]]),
    );
    const rows = await getActiveUsers({ now: NOW, windowDays: 30 });
    expect(rows[0].status).toBe('active');
    expect(rows[0].posts7d).toBe(1);
  });

  it('classifies users with recent signin but no action as dormant', async () => {
    dbSelectReturn.mockResolvedValueOnce([
      {
        userId: 'u2',
        email: 'b@x.com',
        createdAt: ago(15),
        lastLoginAt: ago(3),
      },
    ]);
    activityCountsMock.mockResolvedValueOnce(
      new Map([['u2', { posts7d: 0, replies7d: 0, scans7d: 0 }]]),
    );
    const rows = await getActiveUsers({ now: NOW, windowDays: 30 });
    expect(rows[0].status).toBe('dormant');
  });

  it('classifies users with no signin in 14d as lost', async () => {
    dbSelectReturn.mockResolvedValueOnce([
      {
        userId: 'u3',
        email: 'c@x.com',
        createdAt: ago(28),
        lastLoginAt: ago(20),
      },
    ]);
    activityCountsMock.mockResolvedValueOnce(
      new Map([['u3', { posts7d: 0, replies7d: 0, scans7d: 0 }]]),
    );
    const rows = await getActiveUsers({ now: NOW, windowDays: 30 });
    expect(rows[0].status).toBe('lost');
  });

  it('fills in zero counts for users without activity entries', async () => {
    dbSelectReturn.mockResolvedValueOnce([
      {
        userId: 'u4',
        email: 'd@x.com',
        createdAt: ago(5),
        lastLoginAt: ago(5),
      },
    ]);
    activityCountsMock.mockResolvedValueOnce(new Map()); // no entries
    const rows = await getActiveUsers({ now: NOW, windowDays: 30 });
    expect(rows[0].scans7d).toBe(0);
    expect(rows[0].replies7d).toBe(0);
    expect(rows[0].posts7d).toBe(0);
  });

  it('handles null lastLoginAt without throwing', async () => {
    dbSelectReturn.mockResolvedValueOnce([
      {
        userId: 'u5',
        email: 'e@x.com',
        createdAt: ago(5),
        lastLoginAt: null,
      },
    ]);
    activityCountsMock.mockResolvedValueOnce(new Map());
    const rows = await getActiveUsers({ now: NOW, windowDays: 30 });
    expect(rows[0].status).toBe('lost'); // no login in 14d (never logged in)
  });

  it('falls back to "(no email)" when user.email is null', async () => {
    dbSelectReturn.mockResolvedValueOnce([
      {
        userId: 'u6',
        email: null,
        createdAt: ago(5),
        lastLoginAt: ago(5),
      },
    ]);
    activityCountsMock.mockResolvedValueOnce(new Map());
    const rows = await getActiveUsers({ now: NOW, windowDays: 30 });
    expect(rows[0].email).toBe('(no email)');
  });
});
