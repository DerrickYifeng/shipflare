import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let allowedRL = true;
vi.mock('@/lib/rate-limit', () => ({
  acquireRateLimit: vi.fn(async () => ({
    allowed: allowedRL,
    retryAfterSeconds: allowedRL ? 0 : 3,
  })),
}));

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
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

vi.mock('@/lib/platform-config', () => ({
  isPlatformAvailable: (p: string) => ['x', 'reddit'].includes(p),
}));

const auditSeoMock = vi.fn(async () => ({ checks: [], score: 0 }));
vi.mock('@/tools/seo-audit', () => ({
  auditSeo: auditSeoMock,
}));

// `@/lib/queue` no longer has to be mocked — the PATCH route does not
// enqueue anything in discovery v3.

let prevProduct: Record<string, unknown> | null = null;
let userChannelRows: Array<{ platform: string }> = [];

const updateSet = vi.fn(
  (_patch: Record<string, unknown>) => ({ where: async () => undefined }),
);
const insertOnConflict = vi.fn(async () => undefined);

vi.mock('@/lib/db', () => ({
  db: {
    select: (projection?: unknown) => {
      const sel = projection as Record<string, unknown> | undefined;
      const fields = sel ? Object.keys(sel) : [];
      return {
        from: () => ({
          where: () => {
            if (fields.length === 1 && fields[0] === 'platform') {
              return userChannelRows;
            }
            return { limit: () => (prevProduct ? [prevProduct] : []) };
          },
        }),
      };
    },
    update: () => ({ set: updateSet }),
    insert: () => ({
      values: () => ({ onConflictDoUpdate: insertOnConflict }),
    }),
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
  return { ...actual, eq: () => ({}), desc: () => ({}) };
});

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const productFixture = {
  id: 'prod-1',
  name: 'ShipFlare',
  description: 'Marketing autopilot',
  keywords: ['indiedev', 'saas'],
  valueProp: 'ship faster',
};

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/product', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  allowedRL = true;
  authUserId = 'user-1';
  prevProduct = null;
  userChannelRows = [];
  updateSet.mockClear();
  insertOnConflict.mockClear();
  auditSeoMock.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PATCH /api/product', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ name: 'X' }));
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate-limited', async () => {
    allowedRL = false;
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ name: 'X' }));
    expect(res.status).toBe(429);
  });

  it('returns 404 when the user has no product', async () => {
    prevProduct = null;
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ name: 'X' }));
    expect(res.status).toBe(404);
  });

  it('returns 400 on schema violation (non-string name)', async () => {
    prevProduct = productFixture;
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ name: 42 }));
    expect(res.status).toBe(400);
  });

  it('updates only the fields the caller sent', async () => {
    prevProduct = productFixture;
    userChannelRows = [];
    const { PATCH } = await import('../route');
    const res = await PATCH(
      makeReq({ valueProp: 'ship faster than ever' }),
    );
    expect(res.status).toBe(200);
    expect(updateSet).toHaveBeenCalledTimes(1);
    const patch = updateSet.mock.calls[0][0];
    // Only valueProp and updatedAt should be written on identity edit
    expect(patch.valueProp).toBe('ship faster than ever');
    expect('name' in patch).toBe(false);
    expect('description' in patch).toBe(false);
    expect('keywords' in patch).toBe(false);
  });

  // Discovery v3: legacy calibration tests removed. Clearing the memory
  // entry on core-field change is covered by the MemoryStore unit tests.

  it('merge=true preserves non-placeholder existing values and unions keywords', async () => {
    prevProduct = productFixture;
    const { PATCH } = await import('../route');
    await PATCH(
      makeReq({
        name: 'IgnoreMe',
        description: 'ignore-me',
        keywords: ['new-keyword'],
        valueProp: 'ignore-me-too',
        merge: true,
      }),
    );
    const patch = updateSet.mock.calls[0][0];
    // prev.name/desc/valueProp are non-placeholder, so merge must preserve them
    expect(patch.name).toBe('ShipFlare');
    expect(patch.description).toBe('Marketing autopilot');
    expect(patch.valueProp).toBe('ship faster');
    // keywords union
    expect(patch.keywords).toEqual(
      expect.arrayContaining(['indiedev', 'saas', 'new-keyword']),
    );
  });

  it('runs SEO audit when a url is provided', async () => {
    prevProduct = productFixture;
    const { PATCH } = await import('../route');
    await PATCH(makeReq({ url: 'https://shipflare.dev' }));
    expect(auditSeoMock).toHaveBeenCalledWith('https://shipflare.dev');
  });
});
