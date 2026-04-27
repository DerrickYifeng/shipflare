import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  channelRows: [] as Array<{
    id: string;
    platform: string;
    oauthTokenEncrypted: string;
    refreshTokenEncrypted: string;
    tokenExpiresAt: Date | null;
  }>,
  redditFromChannel: vi.fn(() => ({ __kind: 'reddit' })),
  xFromChannel: vi.fn(() => ({ __kind: 'x' })),
  xaiCtor: vi.fn(),
  memoryStoreCtor: vi.fn(),
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
        where: async () => hoisted.channelRows,
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
  RedditClient: {
    fromChannel: hoisted.redditFromChannel,
    appOnly: () => ({ __kind: 'reddit-app' }),
  },
}));

vi.mock('@/lib/xai-client', () => ({
  XAIClient: class {
    constructor() {
      hoisted.xaiCtor();
    }
  },
}));

vi.mock('@/lib/x-client', () => ({
  XClient: {
    fromChannel: hoisted.xFromChannel,
  },
}));

vi.mock('@/lib/platform-config', () => ({
  PLATFORMS: {
    reddit: { id: 'reddit', supportsAnonymousRead: true },
    x: { id: 'x', supportsAnonymousRead: false, envGuard: 'XAI_API_KEY' },
  },
}));

vi.mock('@/memory/store', () => ({
  MemoryStore: class {
    constructor(userId: string, productId: string) {
      hoisted.memoryStoreCtor(userId, productId);
    }
  },
}));

import { createTeamPlatformDeps } from '../platform-deps';

describe('createTeamPlatformDeps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.channelRows.length = 0;
    process.env.XAI_API_KEY = 'sk-test';
  });

  afterEach(() => {
    delete process.env.XAI_API_KEY;
  });

  it('always instantiates xaiClient when XAI_API_KEY is set (no channel needed)', async () => {
    const deps = await createTeamPlatformDeps('user-1', 'product-1');
    expect(deps.xaiClient).toBeDefined();
    expect(hoisted.xaiCtor).toHaveBeenCalledOnce();
  });

  it('omits xaiClient when XAI_API_KEY is absent', async () => {
    delete process.env.XAI_API_KEY;
    const deps = await createTeamPlatformDeps('user-1', 'product-1');
    expect(deps.xaiClient).toBeUndefined();
    expect(hoisted.xaiCtor).not.toHaveBeenCalled();
  });

  it('instantiates redditClient for a connected reddit channel', async () => {
    hoisted.channelRows.push({
      id: 'ch-reddit',
      platform: 'reddit',
      oauthTokenEncrypted: 't',
      refreshTokenEncrypted: 'r',
      tokenExpiresAt: null,
    });
    const deps = await createTeamPlatformDeps('user-1', 'product-1');
    expect(deps.redditClient).toBeDefined();
    expect(hoisted.redditFromChannel).toHaveBeenCalledOnce();
  });

  it('instantiates xClient for a connected x channel', async () => {
    hoisted.channelRows.push({
      id: 'ch-x',
      platform: 'x',
      oauthTokenEncrypted: 't',
      refreshTokenEncrypted: 'r',
      tokenExpiresAt: null,
    });
    const deps = await createTeamPlatformDeps('user-1', 'product-1');
    expect(deps.xClient).toBeDefined();
    expect(hoisted.xFromChannel).toHaveBeenCalledOnce();
  });

  it('returns both platform clients when the user has both channels', async () => {
    hoisted.channelRows.push(
      {
        id: 'ch-reddit',
        platform: 'reddit',
        oauthTokenEncrypted: 't',
        refreshTokenEncrypted: 'r',
        tokenExpiresAt: null,
      },
      {
        id: 'ch-x',
        platform: 'x',
        oauthTokenEncrypted: 't',
        refreshTokenEncrypted: 'r',
        tokenExpiresAt: null,
      },
    );
    const deps = await createTeamPlatformDeps('user-1', 'product-1');
    expect(deps.redditClient).toBeDefined();
    expect(deps.xClient).toBeDefined();
    // xaiClient is ALSO always-on when the env key is set.
    expect(deps.xaiClient).toBeDefined();
  });

  it('skips platform clients silently when channel factory throws', async () => {
    hoisted.redditFromChannel.mockImplementationOnce(() => {
      throw new Error('decrypt failed');
    });
    hoisted.channelRows.push({
      id: 'ch-reddit',
      platform: 'reddit',
      oauthTokenEncrypted: 't',
      refreshTokenEncrypted: 'r',
      tokenExpiresAt: null,
    });
    const deps = await createTeamPlatformDeps('user-1', 'product-1');
    expect(deps.redditClient).toBeUndefined();
  });

  it('includes memoryStore when productId is provided', async () => {
    await createTeamPlatformDeps('user-1', 'product-1');
    expect(hoisted.memoryStoreCtor).toHaveBeenCalledWith('user-1', 'product-1');
  });

  it('omits memoryStore when productId is null', async () => {
    const deps = await createTeamPlatformDeps('user-1', null);
    expect(deps.memoryStore).toBeUndefined();
    expect(hoisted.memoryStoreCtor).not.toHaveBeenCalled();
  });
});
