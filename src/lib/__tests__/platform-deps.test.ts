import { describe, expect, it, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  channelRow: null as
    | {
        id: string;
        platform: string;
        oauthTokenEncrypted: string;
        refreshTokenEncrypted: string;
        tokenExpiresAt: Date | null;
      }
    | null,
  redditFromChannel: vi.fn(() => ({ __kind: 'reddit-from-channel' })),
  redditAppOnly: vi.fn(() => ({ __kind: 'reddit-app-only', channelId: 'app-only' })),
  xFromChannel: vi.fn(() => ({ __kind: 'x-from-channel' })),
}));

vi.mock('@/lib/db/schema', () => ({
  channels: {
    id: 'id',
    platform: 'platform',
    oauthTokenEncrypted: 'oauth',
    refreshTokenEncrypted: 'refresh',
    tokenExpiresAt: 'expires',
    userId: 'userId',
  },
}));

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (hoisted.channelRow ? [hoisted.channelRow] : []),
        }),
      }),
    }),
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
  return { ...actual, eq: () => ({}), and: () => ({}) };
});

vi.mock('@/lib/reddit-client', () => ({
  RedditClient: class RedditClient {
    static fromChannel = hoisted.redditFromChannel;
    static appOnly = hoisted.redditAppOnly;
  },
}));

vi.mock('@/lib/x-client', () => ({
  XClient: class XClient {
    static fromChannel = hoisted.xFromChannel;
  },
}));

vi.mock('@/lib/xai-client', () => ({
  XAIClient: class {},
}));

vi.mock('@/lib/platform-config', () => ({
  PLATFORMS: {
    reddit: { id: 'reddit', supportsAnonymousRead: true },
    x: { id: 'x', supportsAnonymousRead: false },
  },
}));

vi.mock('@/memory/store', () => ({
  MemoryStore: class {},
}));

import {
  createClientFromChannel,
  createClientFromChannelById,
} from '../platform-deps';

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.channelRow = null;
});

describe('createClientFromChannel — reddit', () => {
  it('returns appOnly() for reddit even when channel has tokens', () => {
    const channel = {
      id: 'ch-1',
      oauthTokenEncrypted: 'token',
      refreshTokenEncrypted: 'refresh',
      tokenExpiresAt: null,
    };
    const client = createClientFromChannel('reddit', channel);
    expect(hoisted.redditAppOnly).toHaveBeenCalledOnce();
    expect(hoisted.redditFromChannel).not.toHaveBeenCalled();
    // appOnly() instances have channelId === 'app-only'
    expect((client as never as { channelId: string }).channelId).toBe(
      'app-only',
    );
  });

  it('returns appOnly() for reddit when channel has null/empty tokens', () => {
    const channel = {
      id: 'ch-2',
      oauthTokenEncrypted: '',
      refreshTokenEncrypted: '',
      tokenExpiresAt: null,
    };
    const client = createClientFromChannel('reddit', channel);
    expect(hoisted.redditAppOnly).toHaveBeenCalledOnce();
    expect(hoisted.redditFromChannel).not.toHaveBeenCalled();
    expect(client).not.toBeNull();
  });

  it('still uses fromChannel for x', () => {
    const channel = {
      id: 'ch-3',
      oauthTokenEncrypted: 'token',
      refreshTokenEncrypted: 'refresh',
      tokenExpiresAt: null,
    };
    createClientFromChannel('x', channel);
    expect(hoisted.xFromChannel).toHaveBeenCalledOnce();
    expect(hoisted.redditAppOnly).not.toHaveBeenCalled();
  });
});

describe('createClientFromChannelById — reddit', () => {
  it('returns appOnly() for reddit channels even with valid tokens in DB', async () => {
    hoisted.channelRow = {
      id: 'ch-1',
      platform: 'reddit',
      oauthTokenEncrypted: 'token',
      refreshTokenEncrypted: 'refresh',
      tokenExpiresAt: null,
    };
    const result = await createClientFromChannelById('ch-1');
    expect(result).not.toBeNull();
    expect(result?.platform).toBe('reddit');
    expect(hoisted.redditAppOnly).toHaveBeenCalledOnce();
    expect(hoisted.redditFromChannel).not.toHaveBeenCalled();
  });

  it('returns null when the channel does not exist', async () => {
    hoisted.channelRow = null;
    const result = await createClientFromChannelById('nope');
    expect(result).toBeNull();
  });
});
