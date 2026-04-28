import { describe, expect, it, vi, beforeEach } from 'vitest';

// Pure-function tests: we mock the DB lookup so the pacer's slot logic
// can be tested deterministically without a live postgres.
vi.mock('@/lib/db', () => ({
  db: { /* unused — selectRecentPosts is mocked below */ },
}));

import { computeNextSlot, __setRecentPostsSourceForTests } from '../posting-pacer';

interface RecentPost {
  postedAt: Date;
  kind: 'reply' | 'post';
}

function withRecentPosts(rows: RecentPost[]) {
  __setRecentPostsSourceForTests(async () => rows);
}

const NOW = new Date('2026-04-27T15:00:00Z'); // Monday afternoon UTC, outside quiet hours

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  __setRecentPostsSourceForTests(async () => []);
});

describe('computeNextSlot', () => {
  it('returns delayMs=0 when no recent posts and outside quiet hours', async () => {
    const slot = await computeNextSlot({
      userId: 'u1',
      platform: 'x',
      kind: 'reply',
      connectedAgeDays: 60,
    });
    expect(slot.deferred).toBe(false);
    expect(slot.delayMs).toBe(0);
    expect(slot.reason).toBe('immediate');
  });

  it('spaces a follow-up post by minSpacing - now-since-last, plus jitter', async () => {
    const lastPostedAt = new Date(NOW.getTime() - 30_000); // 30s ago
    withRecentPosts([{ postedAt: lastPostedAt, kind: 'reply' }]);

    const slot = await computeNextSlot({
      userId: 'u1',
      platform: 'x',
      kind: 'reply',
      connectedAgeDays: 60, // 30+ tier: 120s spacing ± 60s
    });
    expect(slot.deferred).toBe(false);
    // Earliest = 30s ago + 120s = 90s from now; jitter shifts it to [30, 150]s.
    expect(slot.delayMs).toBeGreaterThanOrEqual(30_000);
    expect(slot.delayMs).toBeLessThanOrEqual(150_000);
    expect(slot.reason).toBe('spaced');
  });

  it('defers when over the daily reply cap', async () => {
    const recent = Array.from({ length: 20 }).map((_, i) => ({
      postedAt: new Date(NOW.getTime() - i * 60_000),
      kind: 'reply' as const,
    }));
    withRecentPosts(recent);

    const slot = await computeNextSlot({
      userId: 'u1',
      platform: 'x',
      kind: 'reply',
      connectedAgeDays: 60, // 30+ tier: 20 replies/day cap
    });
    expect(slot.deferred).toBe(true);
    expect(slot.reason).toBe('over_daily_cap');
    // Defers to next active hour after the oldest reply rolls out of the 24h window
    expect(slot.delayMs).toBeGreaterThan(0);
  });

  it('uses the youngest tier when account is brand new', async () => {
    withRecentPosts([]);
    const slot = await computeNextSlot({
      userId: 'u1',
      platform: 'x',
      kind: 'reply',
      connectedAgeDays: 3, // <14 tier: 3 replies/day cap, 480s spacing
    });
    // Empty history → immediate, but the tier choice is reflected later
    // when caps are hit. Here we only verify the slot is immediate.
    expect(slot.deferred).toBe(false);
    expect(slot.delayMs).toBe(0);
  });

  it('pushes into next active window when in quiet hours', async () => {
    vi.setSystemTime(new Date('2026-04-27T08:00:00Z')); // 08:00 UTC = inside [6,11]
    const slot = await computeNextSlot({
      userId: 'u1',
      platform: 'x',
      kind: 'reply',
      connectedAgeDays: 60,
    });
    expect(slot.deferred).toBe(false);
    expect(slot.reason).toBe('quiet_hours');
    // Active window starts at 11:00 UTC = 3h from 08:00. Allow jitter.
    expect(slot.delayMs).toBeGreaterThanOrEqual(3 * 60 * 60 * 1000 - 60_000);
    expect(slot.delayMs).toBeLessThanOrEqual(3 * 60 * 60 * 1000 + 60_000);
  });

  it('returns deferred for platforms without a posting config', async () => {
    const slot = await computeNextSlot({
      userId: 'u1',
      platform: 'unknown',
      kind: 'reply',
      connectedAgeDays: 60,
    });
    expect(slot.deferred).toBe(true);
    expect(slot.reason).toBe('no_pacer_config');
  });
});
