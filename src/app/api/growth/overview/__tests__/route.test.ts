import { describe, it, expect, vi, beforeEach } from 'vitest';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

type LatestScoreRow = {
  platform: string;
  score: number;
  threads: number;
  drafts: number;
  posts: number;
  replies: number;
  pending: number;
  approve_rate: number | null;
  last_post_at: Date | null;
};

// Defaults exercise the cold-start path. Tests override per-case.
let executeReturn: LatestScoreRow[] = [];
let channelRows: Array<{ platform: string; username: string | null }> = [];
let productRow: { id: string } | undefined;
let subredditRows: Array<{ subreddit: string }> = [];

vi.mock('@/lib/db', () => ({
  db: {
    // Used for the DISTINCT ON (platform) latest-scores query.
    execute: vi.fn(async () => executeReturn),

    // Three `.select(...)` call paths fan out:
    //   1. channels lookup
    //   2. products lookup (.limit(1))
    //   3. product_reddit_channels lookup (.orderBy().limit())
    // We disambiguate via the table object passed to `.from()`, which
    // carries a `_label` field via the schema mock below.
    select: vi.fn(() => {
      let phase: 'channels' | 'products' | 'subs' | 'unknown' = 'unknown';
      const chain: {
        from: (table: { _label?: string }) => typeof chain;
        where: () => typeof chain;
        orderBy: () => typeof chain;
        limit: (n: number) => Promise<unknown[]>;
        then: (resolve: (v: unknown[]) => void) => Promise<void>;
      } = {
        from: (table: { _label?: string }) => {
          if (table._label === 'channels') phase = 'channels';
          else if (table._label === 'products') phase = 'products';
          else if (table._label === 'product_reddit_channels') phase = 'subs';
          return chain;
        },
        where: () => chain,
        orderBy: () => chain,
        limit: async (_n: number) => {
          if (phase === 'channels') return channelRows;
          if (phase === 'products') return productRow ? [productRow] : [];
          if (phase === 'subs') return subredditRows;
          return [];
        },
        // The channels lookup has no .limit() — it awaits the chain
        // directly after .where(). `then` makes the chain thenable.
        then: (resolve: (v: unknown[]) => void) => {
          if (phase === 'channels') resolve(channelRows);
          else if (phase === 'products') resolve(productRow ? [productRow] : []);
          else if (phase === 'subs') resolve(subredditRows);
          else resolve([]);
          return Promise.resolve();
        },
      };
      return chain;
    }),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  channels: { _label: 'channels', userId: { _col: 'userId' }, platform: { _col: 'platform' }, username: { _col: 'username' } },
  channelScores: { _label: 'channel_scores' },
  productRedditChannels: {
    _label: 'product_reddit_channels',
    productId: { _col: 'productId' },
    disabled: { _col: 'disabled' },
    rank: { _col: 'rank' },
    subreddit: { _col: 'subreddit' },
  },
  products: { _label: 'products', userId: { _col: 'userId' }, id: { _col: 'id' } },
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: () => ({}),
    and: () => ({}),
    sql: Object.assign(
      (..._args: unknown[]) => ({ mapWith: () => ({}) }),
      { raw: () => ({}) },
    ),
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug() {},
    info() {},
    warn() {},
    error() {},
  }),
}));

import { GET } from '../route';

beforeEach(() => {
  authUserId = 'user-1';
  executeReturn = [];
  channelRows = [];
  productRow = undefined;
  subredditRows = [];
});

describe('GET /api/growth/overview', () => {
  it('401 when not authenticated', async () => {
    authUserId = null;
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('cold start — overallScore null; social channels have score null + counts 0', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      overallScore: number | null;
      modules: Array<{
        id: string;
        live: boolean;
        score: number | null;
        channels?: Array<{
          platform: string;
          score: number | null;
          threads: number;
          connected: boolean;
          handleOrLabel: string;
          activeSubreddits?: string[];
        }>;
      }>;
    };
    expect(body.overallScore).toBeNull();
    const social = body.modules.find((m) => m.id === 'social');
    expect(social).toBeDefined();
    expect(social?.score).toBeNull();
    expect(social?.live).toBe(true);
    expect(social?.channels).toBeDefined();
    const xChan = social?.channels?.find((c) => c.platform === 'x');
    expect(xChan?.score).toBeNull();
    expect(xChan?.threads).toBe(0);
    expect(xChan?.connected).toBe(false);
    expect(xChan?.handleOrLabel).toBe('Not connected');
    const redditChan = social?.channels?.find((c) => c.platform === 'reddit');
    // Reddit is no-binding always-on — never reads from `channels`, so it
    // renders as connected (handoff mode) even on cold start.
    expect(redditChan?.connected).toBe(true);
    expect(redditChan?.handleOrLabel).toBe('Handoff mode');
    expect(redditChan?.activeSubreddits).toEqual([]);
  });

  it('modules render in declared order', async () => {
    const res = await GET();
    const body = (await res.json()) as { modules: Array<{ id: string }> };
    const ids = body.modules.map((m) => m.id);
    expect(ids).toEqual(['social', 'search', 'performance', 'content', 'analytics']);
  });

  it('non-live modules have score null and no channels array', async () => {
    const res = await GET();
    const body = (await res.json()) as {
      modules: Array<{
        id: string;
        live: boolean;
        score: number | null;
        channels?: unknown;
      }>;
    };
    const search = body.modules.find((m) => m.id === 'search');
    expect(search?.live).toBe(false);
    expect(search?.score).toBeNull();
    expect(search?.channels).toBeUndefined();
  });

  it('happy path — overallScore equals social score when only social is live', async () => {
    executeReturn = [
      {
        platform: 'x',
        score: 80,
        threads: 30,
        drafts: 20,
        posts: 5,
        replies: 15,
        pending: 2,
        approve_rate: 0.75,
        last_post_at: new Date('2026-05-12T10:00:00Z'),
      },
      {
        platform: 'reddit',
        score: 60,
        threads: 12,
        drafts: 8,
        posts: 2,
        replies: 5,
        pending: 1,
        approve_rate: 0.6,
        last_post_at: new Date('2026-05-11T09:00:00Z'),
      },
    ];
    channelRows = [
      { platform: 'x', username: 'yifeng' },
      { platform: 'reddit', username: null },
    ];
    productRow = { id: 'p1' };
    subredditRows = [{ subreddit: 'SaaS' }, { subreddit: 'startups' }];

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      overallScore: number | null;
      modules: Array<{
        id: string;
        score: number | null;
        channels?: Array<{
          platform: string;
          score: number | null;
          connected: boolean;
          handleOrLabel: string;
          activeSubreddits?: string[];
        }>;
      }>;
    };
    expect(body.overallScore).toBe(70);
    const social = body.modules.find((m) => m.id === 'social');
    expect(social?.score).toBe(70);
    const xChan = social?.channels?.find((c) => c.platform === 'x');
    expect(xChan?.connected).toBe(true);
    expect(xChan?.handleOrLabel).toBe('@yifeng');
    expect(xChan?.score).toBe(80);
    const redditChan = social?.channels?.find((c) => c.platform === 'reddit');
    expect(redditChan?.connected).toBe(true);
    expect(redditChan?.handleOrLabel).toBe('Handoff mode');
    expect(redditChan?.activeSubreddits).toEqual(['SaaS', 'startups']);
  });
});
