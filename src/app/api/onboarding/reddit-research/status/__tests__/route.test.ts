import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ──────────────────────────────────────────────────────────────────

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

const productSelectMock = vi.fn();
const autoSelectMock = vi.fn();
// db.select is invoked twice — first for products, then for
// productRedditChannels. We dispatch based on call order.
let dbSelectCallCount = 0;

vi.mock('@/lib/db', () => ({
  db: {
    select: () => {
      const callIndex = dbSelectCallCount++;
      return {
        from: () => ({
          where: () => ({
            limit: () =>
              callIndex === 0
                ? productSelectMock()
                : autoSelectMock(),
          }),
        }),
      };
    },
  },
}));

vi.mock('@/lib/db/schema', () => ({
  products: { id: 'id', userId: 'user_id' },
  productRedditChannels: { id: 'id', productId: 'product_id', source: 'source' },
}));

const getJobsMock = vi.fn();
vi.mock('@/lib/queue', () => ({
  redditChannelResearchQueue: {
    getJobs: getJobsMock,
  },
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

function makeGet(): NextRequest {
  return new NextRequest(
    'http://localhost/api/onboarding/reddit-research/status',
    { method: 'GET' },
  );
}

beforeEach(() => {
  authUserId = 'user-1';
  dbSelectCallCount = 0;
  productSelectMock.mockReset();
  autoSelectMock.mockReset();
  getJobsMock.mockReset();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/onboarding/reddit-research/status', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { GET } = await import('../route');
    const res = await GET(makeGet());
    expect(res.status).toBe(401);
  });

  it('returns 404 when the user has no product', async () => {
    productSelectMock.mockResolvedValueOnce([]);
    const { GET } = await import('../route');
    const res = await GET(makeGet());
    expect(res.status).toBe(404);
  });

  it('returns done when at least one auto row exists', async () => {
    productSelectMock.mockResolvedValueOnce([{ id: 'prod-1' }]);
    autoSelectMock.mockResolvedValueOnce([{ id: 'channel-1' }]);
    const { GET } = await import('../route');
    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'done', count: 1 });
    // No need to hit BullMQ when auto rows exist.
    expect(getJobsMock).not.toHaveBeenCalled();
  });

  it('returns pending when an in-flight job exists for this product', async () => {
    productSelectMock.mockResolvedValueOnce([{ id: 'prod-1' }]);
    autoSelectMock.mockResolvedValueOnce([]);
    getJobsMock.mockResolvedValueOnce([
      {
        data: { productId: 'prod-1' },
        getState: async () => 'active',
      },
    ]);
    const { GET } = await import('../route');
    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'pending', count: 0 });
  });

  it('ignores jobs for other products', async () => {
    productSelectMock.mockResolvedValueOnce([{ id: 'prod-1' }]);
    autoSelectMock.mockResolvedValueOnce([]);
    getJobsMock.mockResolvedValueOnce([
      {
        data: { productId: 'someone-else' },
        getState: async () => 'active',
      },
    ]);
    const { GET } = await import('../route');
    const res = await GET(makeGet());
    expect(await res.json()).toEqual({ status: 'pending', count: 0 });
  });

  it('returns pending when no autos and no jobs (safe default)', async () => {
    productSelectMock.mockResolvedValueOnce([{ id: 'prod-1' }]);
    autoSelectMock.mockResolvedValueOnce([]);
    getJobsMock.mockResolvedValueOnce([]);
    const { GET } = await import('../route');
    const res = await GET(makeGet());
    expect(await res.json()).toEqual({ status: 'pending', count: 0 });
  });

  it('returns failed when a recent failed job exists for this product', async () => {
    productSelectMock.mockResolvedValueOnce([{ id: 'prod-1' }]);
    autoSelectMock.mockResolvedValueOnce([]);
    getJobsMock.mockResolvedValueOnce([
      {
        data: { productId: 'prod-1' },
        finishedOn: Date.now() - 1000,
        getState: async () => 'failed',
      },
    ]);
    const { GET } = await import('../route');
    const res = await GET(makeGet());
    expect(await res.json()).toEqual({ status: 'failed', count: 0 });
  });

  it('treats old failed jobs (>5 min) as pending', async () => {
    productSelectMock.mockResolvedValueOnce([{ id: 'prod-1' }]);
    autoSelectMock.mockResolvedValueOnce([]);
    getJobsMock.mockResolvedValueOnce([
      {
        data: { productId: 'prod-1' },
        finishedOn: Date.now() - 10 * 60_000,
        getState: async () => 'failed',
      },
    ]);
    const { GET } = await import('../route');
    const res = await GET(makeGet());
    expect(await res.json()).toEqual({ status: 'pending', count: 0 });
  });

  it('prefers in-flight over failed when both exist', async () => {
    productSelectMock.mockResolvedValueOnce([{ id: 'prod-1' }]);
    autoSelectMock.mockResolvedValueOnce([]);
    getJobsMock.mockResolvedValueOnce([
      {
        data: { productId: 'prod-1' },
        finishedOn: Date.now() - 1000,
        getState: async () => 'failed',
      },
      {
        data: { productId: 'prod-1' },
        getState: async () => 'waiting',
      },
    ]);
    const { GET } = await import('../route');
    const res = await GET(makeGet());
    expect(await res.json()).toEqual({ status: 'pending', count: 0 });
  });
});
