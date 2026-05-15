import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks (top-level for vi hoisting) ──────────────────────────────────────

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

const findProductMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => findProductMock(),
        }),
      }),
    }),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  products: { id: 'id', userId: 'user_id' },
}));

const enqueueRedditChannelResearchMock = vi.fn();
vi.mock('@/lib/queue', () => ({
  enqueueRedditChannelResearch: enqueueRedditChannelResearchMock,
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

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
  return {
    ...actual,
    eq: (_col: unknown, value: unknown) => ({ __eqValue: value as string }),
  };
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makePost(): NextRequest {
  return new NextRequest('http://localhost/api/reddit-channels/re-research', {
    method: 'POST',
  });
}

beforeEach(() => {
  authUserId = 'user-1';
  findProductMock.mockReset();
  enqueueRedditChannelResearchMock.mockReset();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/reddit-channels/re-research', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { POST } = await import('../route');
    const res = await POST(makePost());
    expect(res.status).toBe(401);
    expect(enqueueRedditChannelResearchMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the user has no product', async () => {
    findProductMock.mockResolvedValueOnce([]);
    const { POST } = await import('../route');
    const res = await POST(makePost());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('no_product');
    expect(enqueueRedditChannelResearchMock).not.toHaveBeenCalled();
  });

  it('enqueues research with force=true and returns ok', async () => {
    findProductMock.mockResolvedValueOnce([{ id: 'prod-1' }]);
    enqueueRedditChannelResearchMock.mockResolvedValueOnce(undefined);
    const { POST } = await import('../route');
    const res = await POST(makePost());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(enqueueRedditChannelResearchMock).toHaveBeenCalledTimes(1);
    expect(enqueueRedditChannelResearchMock).toHaveBeenCalledWith({
      userId: 'user-1',
      productId: 'prod-1',
      force: true,
    });
  });

  it('multi-tenant safety: enqueues with the session userId, not any client-supplied value', async () => {
    authUserId = 'user-A';
    findProductMock.mockResolvedValueOnce([{ id: 'prod-A' }]);
    enqueueRedditChannelResearchMock.mockResolvedValueOnce(undefined);
    const { POST } = await import('../route');
    const res = await POST(makePost());
    expect(res.status).toBe(200);
    const callArg = enqueueRedditChannelResearchMock.mock.calls[0][0];
    expect(callArg.userId).toBe('user-A');
    expect(callArg.productId).toBe('prod-A');
    expect(callArg.force).toBe(true);
  });
});
