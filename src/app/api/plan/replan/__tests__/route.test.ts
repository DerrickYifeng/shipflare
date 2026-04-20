import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

vi.mock('@/core/skill-loader', () => ({
  loadSkill: () => ({ name: 'tactical-planner' }),
}));

const runSkillMock = vi.fn();
vi.mock('@/core/skill-runner', () => ({
  runSkill: runSkillMock,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  loggerForRequest: () => ({
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    traceId: 'trace-test',
  }),
}));

vi.mock('@/skills/_catalog', () => ({
  SKILL_CATALOG: [],
}));

// db mock — a single row fixture drives the select chain.
let activePathRow: Record<string, unknown> | null = null;
let weekRows: Array<Record<string, unknown>> = [];
let userChannelRows: Array<{ platform: string }> = [];
let txShouldThrow = false;

vi.mock('@/lib/db', () => ({
  db: {
    select: (projection?: unknown) => {
      const fields = projection
        ? Object.keys(projection as Record<string, unknown>)
        : [];
      const isChannels = fields.length === 1 && fields[0] === 'platform';
      return {
        from: () => ({
          innerJoin: () => ({
            where: () => ({ limit: () => (activePathRow ? [activePathRow] : []) }),
          }),
          where: () => (isChannels ? userChannelRows : weekRows),
        }),
      };
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (txShouldThrow) throw new Error('tx-fail');
      const tx = {
        insert: () => ({
          values: () => ({
            returning: () => [{ id: 'plan-123' }],
          }),
        }),
        update: () => ({
          set: () => ({
            where: () => ({ returning: () => [{ id: 'sup-1' }] }),
          }),
        }),
      };
      return fn(tx);
    },
  },
}));

vi.mock('@/lib/platform-config', () => ({
  isPlatformAvailable: (p: string) => ['x', 'reddit'].includes(p),
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const activePathFixture = {
  productId: 'prod-1',
  productName: 'ShipFlare',
  productValueProp: 'Marketing autopilot',
  state: 'launching',
  launchDate: new Date('2026-05-14T00:00:00Z'),
  launchedAt: null,
  pathId: 'path-1',
  pathNarrative: 'narrative long enough to pass schema',
  pathMilestones: [],
  pathThesisArc: [],
  pathContentPillars: ['p1', 'p2', 'p3'],
  pathChannelMix: {
    x: { perWeek: 4, preferredHours: [14, 17, 21] },
  },
  pathPhaseGoals: { audience: 'grow' },
};

const validPlan = {
  plan: { thesis: 't', notes: 'week notes' },
  items: [
    { kind: 'content_post' as const, userAction: 'approve' as const, phase: 'audience' as const, channel: 'x', scheduledAt: '2026-04-22T17:00:00Z', skillName: 'draft-single-post', params: { anchor_theme: 't' }, title: 'A', description: null },
    { kind: 'content_post' as const, userAction: 'approve' as const, phase: 'audience' as const, channel: 'x', scheduledAt: '2026-04-23T17:00:00Z', skillName: 'draft-single-post', params: { anchor_theme: 't' }, title: 'B', description: null },
    { kind: 'content_post' as const, userAction: 'approve' as const, phase: 'audience' as const, channel: 'x', scheduledAt: '2026-04-24T17:00:00Z', skillName: 'draft-single-post', params: { anchor_theme: 't' }, title: 'C', description: null },
  ],
};

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/plan/replan', { method: 'POST' });
}

beforeEach(() => {
  allowedRL = true;
  authUserId = 'user-1';
  activePathRow = null;
  weekRows = [];
  userChannelRows = [{ platform: 'x' }];
  txShouldThrow = false;
  runSkillMock.mockReset();
});

describe('POST /api/plan/replan', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { POST } = await import('../route');
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate-limited', async () => {
    allowedRL = false;
    const { POST } = await import('../route');
    const res = await POST(makeReq());
    expect(res.status).toBe(429);
  });

  it('returns 404 when user has no active strategic_path', async () => {
    activePathRow = null;
    const { POST } = await import('../route');
    const res = await POST(makeReq());
    expect(res.status).toBe(404);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('no_active_path');
  });

  it('returns 400 when path has no channels', async () => {
    activePathRow = {
      ...activePathFixture,
      pathChannelMix: {},
    };
    const { POST } = await import('../route');
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('no_channels_in_path');
  });

  it('returns 200 with plan + counts on success', async () => {
    activePathRow = activePathFixture;
    runSkillMock.mockResolvedValueOnce({
      results: [validPlan],
      errors: [],
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'haiku', turns: 1 },
    });
    const { POST } = await import('../route');
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      plan: typeof validPlan;
      itemsInserted: number;
      itemsSuperseded: number;
    };
    expect(payload.plan).toEqual(validPlan);
    expect(payload.itemsInserted).toBe(3);
  });

  it('returns 500 when tactical-planner errors', async () => {
    activePathRow = activePathFixture;
    runSkillMock.mockResolvedValueOnce({
      results: [],
      errors: [{ label: 't', error: 'LLM refused' }],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'haiku', turns: 0 },
    });
    const { POST } = await import('../route');
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
  });

  it('returns 500 when transaction throws', async () => {
    activePathRow = activePathFixture;
    txShouldThrow = true;
    runSkillMock.mockResolvedValueOnce({
      results: [validPlan],
      errors: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'haiku', turns: 1 },
    });
    const { POST } = await import('../route');
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
  });

  it('drops channels from the planner input when the user disconnected them in Settings', async () => {
    // path has x+reddit in its channelMix, but the user only has reddit connected
    // right now (x got disconnected after onboarding).
    activePathRow = {
      ...activePathFixture,
      pathChannelMix: {
        x: { perWeek: 4, preferredHours: [14] },
        reddit: { perWeek: 2, preferredHours: [18] },
      },
    };
    userChannelRows = [{ platform: 'reddit' }];
    runSkillMock.mockResolvedValueOnce({
      results: [validPlan],
      errors: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'haiku', turns: 1 },
    });
    const { POST } = await import('../route');
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const tacticalCall = runSkillMock.mock.calls[0]?.[0] as {
      input: { channels: string[] };
    };
    expect(tacticalCall.input.channels).toEqual(['reddit']);
  });

  it('returns 400 no_channels_in_path when user disconnected every channel in the plan', async () => {
    activePathRow = activePathFixture; // channelMix: x only
    userChannelRows = []; // x got disconnected, nothing left (email not in mix)
    const { POST } = await import('../route');
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('no_channels_in_path');
  });

  it('keeps email in planner channels even with no channels-table row', async () => {
    // Email isn't an OAuth platform so it doesn't appear in the channels
    // table; getUserChannels() can't return it. The intersection logic
    // special-cases email and keeps it whenever the path includes it.
    activePathRow = {
      ...activePathFixture,
      pathChannelMix: {
        x: { perWeek: 4, preferredHours: [14] },
        email: { perWeek: 1, preferredHours: [9] },
      },
    };
    userChannelRows = []; // no OAuth channels at all
    runSkillMock.mockResolvedValueOnce({
      results: [validPlan],
      errors: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'haiku', turns: 1 },
    });
    const { POST } = await import('../route');
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const tacticalCall = runSkillMock.mock.calls[0]?.[0] as {
      input: { channels: string[] };
    };
    expect(tacticalCall.input.channels).toEqual(['email']);
  });
});
