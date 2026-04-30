/**
 * query_recent_x_posts unit tests. Stubs XClient and the channels DB
 * lookup; asserts the tool's contract: shape, window filtering, and
 * the four error-fallback paths.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolContext } from '@/core/types';
import {
  createInMemoryStore,
  drizzleMockFactory,
  type InMemoryStore,
} from '@/lib/test-utils/in-memory-db';

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return drizzleMockFactory(actual as unknown as Record<string, unknown>);
});
vi.mock('@/lib/db', () => ({ db: createInMemoryStore().db }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// XClient.fromChannel + ensureValidToken + getMe + getUserTweets are
// stubbed via a factory so each test installs the behavior it needs.
let stubGetMe: () => Promise<{ id: string; username: string }>;
let stubGetUserTweets: (
  userId: string,
  opts: { maxResults?: number; sinceId?: string },
) => Promise<{ tweets: Array<TweetStub>; newestId?: string }>;

interface TweetStub {
  id: string;
  text: string;
  authorUsername: string;
  createdAt: string;
  metrics: {
    likes: number;
    retweets: number;
    replies: number;
    impressions: number;
  };
  referencedTweets?: Array<{ type: string; id: string }>;
}

vi.mock('@/lib/x-client', () => ({
  XClient: {
    fromChannel: () => ({
      getMe: () => stubGetMe(),
      getUserTweets: (id: string, o: { maxResults?: number }) =>
        stubGetUserTweets(id, o),
    }),
  },
}));

import { queryRecentXPostsTool } from '../QueryRecentXPostsTool';
import { channels } from '@/lib/db/schema';

interface ChannelRow {
  id: string;
  userId: string;
  platform: string;
  username: string;
  oauthTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiresAt: Date | null;
}

function makeCtx(
  store: InMemoryStore,
  deps: Record<string, unknown>,
): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    get<V>(key: string): V {
      if (key in deps) return deps[key] as V;
      if (key === 'db') return store.db as unknown as V;
      throw new Error(`no dep ${key}`);
    },
  };
}

let store: InMemoryStore;
beforeEach(() => {
  store = createInMemoryStore();
  // Default stubs — happy path. Tests override per-case.
  stubGetMe = async () => ({ id: '1234567', username: 'founder' });
  stubGetUserTweets = async () => ({ tweets: [], newestId: undefined });
});

const NOW = new Date('2026-04-29T12:00:00Z').getTime();
const dayAgoIso = (days: number): string =>
  new Date(NOW - days * 86_400_000).toISOString();

describe('queryRecentXPostsTool', () => {
  it('returns empty tweets and error="no_channel" when the user has not connected X', async () => {
    store.register<ChannelRow>(channels, []);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });

    const result = await queryRecentXPostsTool.execute({ days: 14 }, ctx);

    expect(result.source).toBe('x_api');
    expect(result.windowDays).toBe(14);
    expect(result.tweets).toEqual([]);
    expect(result.error).toBe('no_channel');
  });

  it('returns the user\'s recent original tweets within the window', async () => {
    store.register<ChannelRow>(channels, [
      {
        id: 'ch-1',
        userId: 'user-1',
        platform: 'x',
        username: 'founder',
        oauthTokenEncrypted: 'enc-token',
        refreshTokenEncrypted: 'enc-refresh',
        tokenExpiresAt: null,
      },
    ]);
    stubGetUserTweets = async () => ({
      tweets: [
        {
          id: 't1',
          text: 'Day 47 of building. Shipped auth.',
          authorUsername: 'founder',
          createdAt: dayAgoIso(2),
          metrics: { likes: 10, retweets: 1, replies: 0, impressions: 500 },
        },
        {
          id: 't2',
          text: 'Marketing debt compounds like tech debt.',
          authorUsername: 'founder',
          createdAt: dayAgoIso(5),
          metrics: { likes: 47, retweets: 3, replies: 12, impressions: 2300 },
        },
      ],
      newestId: 't1',
    });

    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await queryRecentXPostsTool.execute({ days: 14 }, ctx);

    expect(result.error).toBeUndefined();
    expect(result.tweets).toHaveLength(2);
    expect(result.tweets[0]).toMatchObject({
      tweetId: 't1',
      kind: 'original',
      body: 'Day 47 of building. Shipped auth.',
      metrics: { likes: 10, retweets: 1, replies: 0, impressions: 500 },
    });
    expect(result.tweets[1].body).toBe(
      'Marketing debt compounds like tech debt.',
    );
  });

  it('marks tweets with referenced_tweets[?].type==="replied_to" as kind="reply"', async () => {
    store.register<ChannelRow>(channels, [
      {
        id: 'ch-1',
        userId: 'user-1',
        platform: 'x',
        username: 'founder',
        oauthTokenEncrypted: 'enc',
        refreshTokenEncrypted: 'enc',
        tokenExpiresAt: null,
      },
    ]);
    stubGetUserTweets = async () => ({
      tweets: [
        {
          id: 'r1',
          text: 'agreed — what worked for us was X',
          authorUsername: 'founder',
          createdAt: dayAgoIso(1),
          metrics: { likes: 2, retweets: 0, replies: 0, impressions: 50 },
          referencedTweets: [{ type: 'replied_to', id: '99999' }],
        },
      ],
    });

    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await queryRecentXPostsTool.execute({ days: 14 }, ctx);
    expect(result.tweets[0].kind).toBe('reply');
  });

  it('filters out tweets older than the window', async () => {
    store.register<ChannelRow>(channels, [
      {
        id: 'ch-1',
        userId: 'user-1',
        platform: 'x',
        username: 'founder',
        oauthTokenEncrypted: 'enc',
        refreshTokenEncrypted: 'enc',
        tokenExpiresAt: null,
      },
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    stubGetUserTweets = async () => ({
      tweets: [
        {
          id: 'in-window',
          text: 'recent',
          authorUsername: 'founder',
          createdAt: dayAgoIso(5),
          metrics: { likes: 0, retweets: 0, replies: 0, impressions: 0 },
        },
        {
          id: 'too-old',
          text: 'ancient',
          authorUsername: 'founder',
          createdAt: dayAgoIso(20),
          metrics: { likes: 0, retweets: 0, replies: 0, impressions: 0 },
        },
      ],
    });

    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await queryRecentXPostsTool.execute({ days: 14 }, ctx);
    vi.useRealTimers();

    expect(result.tweets.map((t) => t.tweetId)).toEqual(['in-window']);
  });

  it('returns error="token_invalid" when XClient throws on auth', async () => {
    store.register<ChannelRow>(channels, [
      {
        id: 'ch-1',
        userId: 'user-1',
        platform: 'x',
        username: 'founder',
        oauthTokenEncrypted: 'enc',
        refreshTokenEncrypted: 'enc',
        tokenExpiresAt: null,
      },
    ]);
    stubGetMe = async () => {
      throw new Error('Unauthorized: token expired');
    };

    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await queryRecentXPostsTool.execute({ days: 14 }, ctx);

    expect(result.tweets).toEqual([]);
    expect(result.error).toBe('token_invalid');
  });

  it('rejects out-of-range `days` via the schema', () => {
    const parse = queryRecentXPostsTool.inputSchema.safeParse({ days: 999 });
    expect(parse.success).toBe(false);
  });

  it('defaults `days` to 14 when omitted', () => {
    const parse = queryRecentXPostsTool.inputSchema.safeParse({});
    expect(parse.success).toBe(true);
    if (parse.success) {
      expect(parse.data.days).toBe(14);
    }
  });
});
