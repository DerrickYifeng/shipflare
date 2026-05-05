import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let allowedRL = true;
vi.mock('@/lib/rate-limit', () => ({
  acquireRateLimit: vi.fn(async () => ({
    allowed: allowedRL,
    retryAfterSeconds: allowedRL ? 0 : 7,
  })),
}));

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  loggerForRequest: () => ({
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    traceId: 'trace-test',
  }),
}));

// Phase E Task 11: the route now dispatches via ensureTeamExists +
// dispatchLeadMessage (insert team_message → wake lead). getUserChannels
// still drives the channels list.
const getUserChannelsMock = vi.fn(async (_userId: string) => ['x']);
vi.mock('@/lib/user-channels', () => ({
  getUserChannels: (userId: string) => getUserChannelsMock(userId),
}));

const ensureTeamExistsMock = vi.fn(
  async (_userId: string, _productId: string | null) => ({
    teamId: 'team-1',
    memberIds: {
      coordinator: 'mem-coord',
      'content-planner': 'mem-cp',
    },
    created: false,
  }),
);
vi.mock('@/lib/team-provisioner', () => ({
  ensureTeamExists: (userId: string, productId: string | null) =>
    ensureTeamExistsMock(userId, productId),
}));

const dispatchLeadMessageMock = vi.fn(async (_input: Record<string, unknown>) => ({
  runId: 'run-phase-1',
  traceId: 'trace-phase-1',
  alreadyRunning: false as const,
}));
vi.mock('@/lib/team/dispatch-lead-message', () => ({
  dispatchLeadMessage: (input: Record<string, unknown>) =>
    dispatchLeadMessageMock(input),
}));

// Minimal validateLaunchDates stub — the real implementation enforces
// per-state date rules which we exercise indirectly by passing valid dates.
// Tests that want to assert 400-on-invalid-dates set customDateErrors.
let customDateErrors: string[] = [];
vi.mock('@/lib/launch-date-rules', () => ({
  validateLaunchDates: () => customDateErrors,
}));

// DB mock — productRow drives the product lookup; transaction runs the
// callback with a tx that records supersede returning().length.
let productRow: Record<string, unknown> | null = null;
let supersededIds: Array<{ id: string }> = [];
let txShouldThrow = false;

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => (productRow ? [productRow] : []),
        }),
      }),
    }),
    // Chat refactor: phase route now calls
    // createAutomationConversation(teamId, 'phase_transition') which
    // does a db.insert(teamConversations).values(...).returning(). The
    // mock just returns a fixed conversation id so the enqueue arg
    // assertion still has a valid shape.
    insert: () => ({
      values: () => ({
        returning: () => [{ id: 'conv-phase-test' }],
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (txShouldThrow) throw new Error('tx-fail');
      const tx = {
        update: () => ({
          set: () => ({
            where: () => ({ returning: () => supersededIds }),
          }),
        }),
      };
      return fn(tx);
    },
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: () => ({}),
    and: () => ({}),
    gte: () => ({}),
    lt: () => ({}),
    inArray: () => ({}),
    ne: () => ({}),
    sql: Object.assign(() => ({}), { raw: () => ({}) }),
  };
});

const productFixture = { id: 'prod-1', name: 'ShipFlare' };

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/product/phase', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  allowedRL = true;
  authUserId = 'user-1';
  productRow = productFixture;
  supersededIds = [];
  txShouldThrow = false;
  customDateErrors = [];
  getUserChannelsMock.mockClear();
  getUserChannelsMock.mockImplementation(async () => ['x']);
  ensureTeamExistsMock.mockClear();
  dispatchLeadMessageMock.mockClear();
});

describe('POST /api/product/phase', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { POST } = await import('../route');
    const res = await POST(makeReq({ state: 'mvp' }));
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate-limited', async () => {
    allowedRL = false;
    const { POST } = await import('../route');
    const res = await POST(makeReq({ state: 'mvp' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('7');
  });

  it('returns 400 on invalid request body', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeReq({ state: 'bogus' }));
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('invalid_request');
  });

  it('returns 400 when validateLaunchDates reports errors', async () => {
    customDateErrors = ['launchDate required when state=launching'];
    const { POST } = await import('../route');
    const res = await POST(
      makeReq({ state: 'launching', launchDate: null }),
    );
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string; detail: unknown };
    expect(payload.error).toBe('invalid_dates');
    expect(payload.detail).toEqual(customDateErrors);
  });

  it('returns 404 when the user has no product', async () => {
    productRow = null;
    const { POST } = await import('../route');
    const res = await POST(makeReq({ state: 'mvp' }));
    expect(res.status).toBe(404);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('no_product');
  });

  it('dispatches a lead message on success and returns { runId, phase, itemsSuperseded }', async () => {
    supersededIds = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
    const { POST } = await import('../route');
    const res = await POST(
      makeReq({
        state: 'launching',
        launchDate: '2026-05-14T00:00:00.000Z',
        launchedAt: null,
      }),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      success: boolean;
      runId: string;
      phase: string;
      itemsSuperseded: number;
    };
    expect(payload.success).toBe(true);
    expect(payload.runId).toBe('run-phase-1');
    expect(payload.itemsSuperseded).toBe(3);
    // derivePhase('launching', launchDate ~3 weeks out) = 'audience'
    expect(payload.phase).toBe('audience');

    expect(ensureTeamExistsMock).toHaveBeenCalledWith('user-1', 'prod-1');
    expect(dispatchLeadMessageMock).toHaveBeenCalledTimes(1);
    // Phase E shape: lead is the sole recipient — no rootMemberId routing.
    expect(dispatchLeadMessageMock.mock.calls[0]?.[0]).toMatchObject({
      teamId: 'team-1',
      trigger: 'phase_transition',
    });
  });

  it('passes the product name + phase + channels into the coordinator goal', async () => {
    const { POST } = await import('../route');
    await POST(
      makeReq({
        state: 'launched',
        launchDate: null,
        launchedAt: '2026-04-07T00:00:00.000Z',
      }),
    );
    const goal = dispatchLeadMessageMock.mock.calls[0]?.[0]?.goal as string;
    expect(goal).toContain('ShipFlare');
    expect(goal).toContain('launched');
    // derivePhase('launched', 14d ago) = 'compound'
    expect(goal).toContain('compound');
    expect(goal).toContain('x');
  });

  it('returns 500 when the DB transaction fails', async () => {
    txShouldThrow = true;
    const { POST } = await import('../route');
    const res = await POST(makeReq({ state: 'mvp' }));
    expect(res.status).toBe(500);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('phase_change_failed');
  });

  it('returns 500 when the lead dispatch fails', async () => {
    dispatchLeadMessageMock.mockImplementationOnce(async () => {
      throw new Error('redis-down');
    });
    const { POST } = await import('../route');
    const res = await POST(makeReq({ state: 'mvp' }));
    expect(res.status).toBe(500);
    const payload = (await res.json()) as { error: string; detail: string };
    expect(payload.error).toBe('phase_change_failed');
    expect(payload.detail).toBe('redis-down');
  });

  it('falls back to [x] when the user has no connected channels', async () => {
    getUserChannelsMock.mockImplementationOnce(async () => []);
    const { POST } = await import('../route');
    await POST(makeReq({ state: 'mvp' }));
    const goal = dispatchLeadMessageMock.mock.calls[0]?.[0]?.goal as string;
    expect(goal).toContain('x');
  });
});
