import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks (must be top-level for vi hoisting) ──────────────────────────────

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

const findProductMock = vi.fn();
vi.mock('@/lib/db', () => {
  // Drizzle's fluent select(...).from(...).where(...).limit(...) chain.
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => findProductMock(),
          }),
        }),
      }),
    },
  };
});

vi.mock('@/lib/db/schema', () => ({
  products: { id: 'id', userId: 'user_id' },
  productRedditChannels: {},
}));

const listAllSubredditsMock = vi.fn();
const setSubredditDisabledMock = vi.fn();
const upsertManualSubredditMock = vi.fn();
vi.mock('@/lib/db/repositories/product-reddit-channels', () => ({
  listAllSubreddits: listAllSubredditsMock,
  setSubredditDisabled: setSubredditDisabledMock,
  upsertManualSubreddit: upsertManualSubredditMock,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
  loggerForRequest: () => ({
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    traceId: 'trace-test',
  }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeGet(): NextRequest {
  return new NextRequest('http://localhost/api/reddit-channels', {
    method: 'GET',
  });
}

function makePost(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/reddit-channels', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function makePatch(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/reddit-channels', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  authUserId = 'user-1';
  findProductMock.mockReset();
  listAllSubredditsMock.mockReset();
  setSubredditDisabledMock.mockReset();
  upsertManualSubredditMock.mockReset();
});

// ── GET ────────────────────────────────────────────────────────────────────

describe('GET /api/reddit-channels', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { GET } = await import('../route');
    const res = await GET(makeGet());
    expect(res.status).toBe(401);
  });

  it('returns 404 when the user has no product', async () => {
    findProductMock.mockResolvedValueOnce([]);
    const { GET } = await import('../route');
    const res = await GET(makeGet());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_product' });
  });

  it('returns rows for the user product', async () => {
    findProductMock.mockResolvedValueOnce([{ id: 'prod-1' }]);
    const rows = [{ id: 'r1', subreddit: 'SaaS', rank: 1 }];
    listAllSubredditsMock.mockResolvedValueOnce(rows);
    const { GET } = await import('../route');
    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ channels: rows });
    expect(listAllSubredditsMock).toHaveBeenCalledWith('prod-1');
  });
});

// ── POST ───────────────────────────────────────────────────────────────────

describe('POST /api/reddit-channels', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { POST } = await import('../route');
    const res = await POST(makePost({ subreddit: 'SaaS' }));
    expect(res.status).toBe(401);
  });

  it('returns 404 when the user has no product', async () => {
    findProductMock.mockResolvedValueOnce([]);
    const { POST } = await import('../route');
    const res = await POST(makePost({ subreddit: 'SaaS' }));
    expect(res.status).toBe(404);
  });

  it('returns 400 on a subreddit that fails regex', async () => {
    findProductMock.mockResolvedValueOnce([{ id: 'prod-1' }]);
    const { POST } = await import('../route');
    const res = await POST(makePost({ subreddit: 'too short!' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_subreddit');
    expect(upsertManualSubredditMock).not.toHaveBeenCalled();
  });

  it('returns 400 on missing subreddit', async () => {
    findProductMock.mockResolvedValueOnce([{ id: 'prod-1' }]);
    const { POST } = await import('../route');
    const res = await POST(makePost({}));
    expect(res.status).toBe(400);
  });

  it('upserts a valid subreddit and returns ok', async () => {
    findProductMock.mockResolvedValueOnce([{ id: 'prod-1' }]);
    upsertManualSubredditMock.mockResolvedValueOnce(undefined);
    const { POST } = await import('../route');
    const res = await POST(makePost({ subreddit: 'SaaS' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(upsertManualSubredditMock).toHaveBeenCalledWith({
      productId: 'prod-1',
      userId: 'user-1',
      subreddit: 'SaaS',
    });
  });
});

// ── PATCH ──────────────────────────────────────────────────────────────────

describe('PATCH /api/reddit-channels', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { PATCH } = await import('../route');
    const res = await PATCH(
      makePatch({ subreddit: 'SaaS', disabled: true }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when the user has no product', async () => {
    findProductMock.mockResolvedValueOnce([]);
    const { PATCH } = await import('../route');
    const res = await PATCH(
      makePatch({ subreddit: 'SaaS', disabled: true }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 on an invalid body', async () => {
    findProductMock.mockResolvedValueOnce([{ id: 'prod-1' }]);
    const { PATCH } = await import('../route');
    const res = await PATCH(makePatch({ subreddit: 'SaaS' }));
    expect(res.status).toBe(400);
    expect(setSubredditDisabledMock).not.toHaveBeenCalled();
  });

  it('calls setSubredditDisabled and returns ok', async () => {
    findProductMock.mockResolvedValueOnce([{ id: 'prod-1' }]);
    setSubredditDisabledMock.mockResolvedValueOnce(undefined);
    const { PATCH } = await import('../route');
    const res = await PATCH(
      makePatch({ subreddit: 'SaaS', disabled: true }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(setSubredditDisabledMock).toHaveBeenCalledWith(
      'prod-1',
      'SaaS',
      true,
    );
  });
});

// ── Multi-tenant safety ────────────────────────────────────────────────────
//
// Locks in that the route NEVER trusts a client-supplied productId; the
// productId passed to the repository always comes from the session (via
// the products-by-userId lookup). If userA POSTs/PATCHes against a row
// that lives under userB's product, the repository WHERE clause filters
// by userA's productId and the row stays untouched.

describe('multi-tenant safety', () => {
  it('POST scopes upsert to the session user productId, not the request body', async () => {
    authUserId = 'user-A';
    findProductMock.mockResolvedValueOnce([{ id: 'prod-A' }]);
    upsertManualSubredditMock.mockResolvedValueOnce(undefined);
    // Adversarial body: client tries to slip in a tenant override.
    const body = {
      subreddit: 'SaaS',
      productId: 'prod-B',
      userId: 'user-B',
    };
    const { POST } = await import('../route');
    const res = await POST(makePost(body));
    expect(res.status).toBe(200);
    expect(upsertManualSubredditMock).toHaveBeenCalledTimes(1);
    const callArgs = upsertManualSubredditMock.mock.calls[0][0];
    expect(callArgs.productId).toBe('prod-A');
    expect(callArgs.userId).toBe('user-A');
    expect(callArgs.subreddit).toBe('SaaS');
    expect(callArgs.productId).not.toBe('prod-B');
  });

  it('PATCH scopes setSubredditDisabled to the session user productId', async () => {
    authUserId = 'user-A';
    findProductMock.mockResolvedValueOnce([{ id: 'prod-A' }]);
    setSubredditDisabledMock.mockResolvedValueOnce(undefined);
    const { PATCH } = await import('../route');
    const res = await PATCH(
      makePatch({ subreddit: 'SaaS', disabled: true }),
    );
    expect(res.status).toBe(200);
    expect(setSubredditDisabledMock).toHaveBeenCalledTimes(1);
    const [productIdArg, subredditArg, disabledArg] =
      setSubredditDisabledMock.mock.calls[0];
    expect(productIdArg).toBe('prod-A');
    expect(subredditArg).toBe('SaaS');
    expect(disabledArg).toBe(true);
  });

  it('GET scopes listAllSubreddits to the session user productId', async () => {
    authUserId = 'user-A';
    findProductMock.mockResolvedValueOnce([{ id: 'prod-A' }]);
    listAllSubredditsMock.mockResolvedValueOnce([]);
    const { GET } = await import('../route');
    await GET(makeGet());
    expect(listAllSubredditsMock).toHaveBeenCalledWith('prod-A');
  });
});
