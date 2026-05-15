/**
 * product-reddit-channels repository unit tests.
 *
 * Uses the shared in-memory DB pattern from `src/lib/test-utils/in-memory-db.ts`
 * via `vi.mock('drizzle-orm', ...)` + `vi.mock('@/lib/db', ...)`. Mirrors
 * the AddPlanItemTool / UpdatePlanItemTool test setup.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { InMemoryStore } from '@/lib/test-utils/in-memory-db';

// Use vi.hoisted with dynamic import to load the in-memory store helper.
// `vi.mock` factories are hoisted, so we need an async hoisted block to
// capture the store reference both mock factories share.
const hoist = vi.hoisted(async () => {
  const mod = await import('@/lib/test-utils/in-memory-db');
  return {
    sharedStore: mod.createInMemoryStore(),
    drizzleMockFactory: mod.drizzleMockFactory,
  };
});

vi.mock('drizzle-orm', async () => {
  const { drizzleMockFactory } = await hoist;
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return drizzleMockFactory(actual as unknown as Record<string, unknown>);
});
vi.mock('@/lib/db', async () => {
  const { sharedStore } = await hoist;
  return { db: sharedStore.db };
});

// Resolved on first beforeEach so test bodies have a sync handle.
let sharedStore: InMemoryStore;

import {
  listActiveSubreddits,
  listAllSubreddits,
  markSubredditUsed,
  setSubredditDisabled,
  upsertManualSubreddit,
} from '../product-reddit-channels';
import { productRedditChannels } from '@/lib/db/schema';

interface RedditChannelRow {
  id: string;
  productId: string;
  userId: string;
  subreddit: string;
  memberCount: number | null;
  fitScore: number | null;
  rulesSummary: string | null;
  activity: unknown;
  rank: number;
  source: string;
  disabled: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function row(overrides: Partial<RedditChannelRow>): RedditChannelRow {
  return {
    id: overrides.id ?? `row-${Math.random().toString(36).slice(2, 8)}`,
    productId: 'prod-1',
    userId: 'user-1',
    subreddit: 'saas',
    memberCount: null,
    fitScore: null,
    rulesSummary: null,
    activity: null,
    rank: 1,
    source: 'auto',
    disabled: false,
    lastUsedAt: null,
    createdAt: new Date('2026-05-01'),
    updatedAt: new Date('2026-05-01'),
    ...overrides,
  };
}

beforeEach(async () => {
  sharedStore = (await hoist).sharedStore;
  sharedStore.register<RedditChannelRow>(productRedditChannels, []);
});

describe('listActiveSubreddits', () => {
  it('returns only disabled=false rows, ordered by rank ASC', async () => {
    sharedStore.register<RedditChannelRow>(productRedditChannels, [
      row({ subreddit: 'beta', rank: 2, fitScore: 0.7 }),
      row({ subreddit: 'alpha', rank: 1, fitScore: 0.9 }),
      row({ subreddit: 'gamma', rank: 3, disabled: true }),
    ]);

    const result = await listActiveSubreddits('prod-1');

    expect(result.map((r) => r.subreddit)).toEqual(['alpha', 'beta']);
    expect(result[0]).toEqual({ subreddit: 'alpha', rank: 1, fitScore: 0.9 });
    expect(result[1]).toEqual({ subreddit: 'beta', rank: 2, fitScore: 0.7 });
  });

  it('returns empty array when product has no rows', async () => {
    sharedStore.register<RedditChannelRow>(productRedditChannels, [
      row({ productId: 'other-prod', subreddit: 'unrelated' }),
    ]);

    const result = await listActiveSubreddits('prod-1');

    expect(result).toEqual([]);
  });
});

describe('listAllSubreddits', () => {
  it('returns BOTH active and disabled rows', async () => {
    sharedStore.register<RedditChannelRow>(productRedditChannels, [
      row({ subreddit: 'active1', rank: 1, disabled: false }),
      row({ subreddit: 'disabled1', rank: 2, disabled: true }),
      row({ subreddit: 'active2', rank: 3, disabled: false }),
    ]);

    const result = await listAllSubreddits('prod-1');

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.subreddit).sort()).toEqual([
      'active1',
      'active2',
      'disabled1',
    ]);
  });
});

describe('markSubredditUsed', () => {
  it('sets lastUsedAt and updatedAt on the matching row', async () => {
    const oldDate = new Date('2026-01-01');
    sharedStore.register<RedditChannelRow>(productRedditChannels, [
      row({
        subreddit: 'saas',
        lastUsedAt: null,
        updatedAt: oldDate,
        createdAt: oldDate,
      }),
      row({
        productId: 'other-prod',
        subreddit: 'saas',
        lastUsedAt: null,
        updatedAt: oldDate,
      }),
    ]);

    const before = Date.now();
    await markSubredditUsed('prod-1', 'saas');
    const after = Date.now();

    const rows = sharedStore.get<RedditChannelRow>(productRedditChannels);
    const target = rows.find(
      (r) => r.productId === 'prod-1' && r.subreddit === 'saas',
    );
    const untouched = rows.find(
      (r) => r.productId === 'other-prod' && r.subreddit === 'saas',
    );

    expect(target?.lastUsedAt).toBeInstanceOf(Date);
    expect(target?.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(target?.lastUsedAt!.getTime()).toBeLessThanOrEqual(after);
    expect(target?.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
    // Other-product row is unchanged.
    expect(untouched?.lastUsedAt).toBeNull();
    expect(untouched?.updatedAt).toEqual(oldDate);
  });
});

describe('setSubredditDisabled', () => {
  it('setSubredditDisabled(true) flips disabled to true; row drops out of listActiveSubreddits', async () => {
    sharedStore.register<RedditChannelRow>(productRedditChannels, [
      row({ subreddit: 'foo', rank: 1, disabled: false }),
      row({ subreddit: 'bar', rank: 2, disabled: false }),
    ]);

    await setSubredditDisabled('prod-1', 'foo', true);

    const all = sharedStore.get<RedditChannelRow>(productRedditChannels);
    expect(all.find((r) => r.subreddit === 'foo')?.disabled).toBe(true);

    const active = await listActiveSubreddits('prod-1');
    expect(active.map((r) => r.subreddit)).toEqual(['bar']);
  });

  it('setSubredditDisabled(false) re-enables a disabled row', async () => {
    sharedStore.register<RedditChannelRow>(productRedditChannels, [
      row({ subreddit: 'foo', rank: 1, disabled: true }),
    ]);

    await setSubredditDisabled('prod-1', 'foo', false);

    const all = sharedStore.get<RedditChannelRow>(productRedditChannels);
    expect(all[0]?.disabled).toBe(false);

    const active = await listActiveSubreddits('prod-1');
    expect(active.map((r) => r.subreddit)).toEqual(['foo']);
  });
});

describe('upsertManualSubreddit', () => {
  it('inserts a new row with source="manual"', async () => {
    sharedStore.register<RedditChannelRow>(productRedditChannels, []);

    await upsertManualSubreddit({
      productId: 'prod-1',
      userId: 'user-1',
      subreddit: 'newcomer',
    });

    const all = sharedStore.get<RedditChannelRow>(productRedditChannels);
    expect(all).toHaveLength(1);
    expect(all[0]?.subreddit).toBe('newcomer');
    expect(all[0]?.source).toBe('manual');
    expect(all[0]?.rank).toBe(99);
    expect(all[0]?.productId).toBe('prod-1');
    expect(all[0]?.userId).toBe('user-1');
  });

  it('on existing row, un-disables it without changing source', async () => {
    sharedStore.register<RedditChannelRow>(productRedditChannels, [
      row({
        subreddit: 'existing',
        source: 'auto',
        disabled: true,
        rank: 1,
      }),
    ]);

    await upsertManualSubreddit({
      productId: 'prod-1',
      userId: 'user-1',
      subreddit: 'existing',
    });

    const all = sharedStore.get<RedditChannelRow>(productRedditChannels);
    expect(all).toHaveLength(1);
    expect(all[0]?.source).toBe('auto');
    expect(all[0]?.disabled).toBe(false);
    expect(all[0]?.rank).toBe(1);
  });
});
