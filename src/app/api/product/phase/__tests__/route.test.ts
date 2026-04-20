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

vi.mock('@/core/skill-loader', () => ({
  loadSkill: (path: string) => ({
    name: path.includes('strategic') ? 'strategic-planner' : 'tactical-planner',
  }),
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

vi.mock('@/lib/platform-config', () => ({
  isPlatformAvailable: (p: string) => ['x', 'reddit'].includes(p),
}));

let productRow: Record<string, unknown> | null = null;
let userChannelRows: Array<{ platform: string }> = [];
let txShouldThrow = false;

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
            return { limit: () => (productRow ? [productRow] : []) };
          },
        }),
      };
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (txShouldThrow) throw new Error('tx-fail');
      const tx = {
        update: () => ({ set: () => ({ where: async () => undefined }) }),
        insert: () => ({
          values: () => ({
            returning: () => [{ id: 'new-id-1' }],
          }),
        }),
      };
      return fn(tx);
    },
  },
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

const productFixture = {
  id: 'prod-1',
  name: 'ShipFlare',
  description: 'Marketing autopilot',
  valueProp: null,
  keywords: ['indiedev'],
  category: 'dev_tool',
  targetAudience: 'solo founders',
};

const validPath = {
  narrative:
    'This is a deliberately long narrative that exceeds the 200-char floor. ' +
    'It names the thesis in paragraph one and sketches the arc in paragraph two so the downstream fixtures have realistic data. ' +
    'We hedge by calling out one risk and the mitigation approach.',
  milestones: [
    { atDayOffset: -28, title: 'x', successMetric: 'x', phase: 'foundation' },
    { atDayOffset: -14, title: 'y', successMetric: 'y', phase: 'audience' },
    { atDayOffset: -7, title: 'z', successMetric: 'z', phase: 'momentum' },
  ],
  thesisArc: [
    { weekStart: '2026-04-20T00:00:00Z', theme: 't', angleMix: ['claim'] },
  ],
  contentPillars: ['a', 'b', 'c'],
  channelMix: { x: { perWeek: 4, preferredHours: [14, 17, 21] } },
  phaseGoals: { audience: 'grow' },
};

const validPlan = {
  plan: { thesis: 't', notes: 'week notes' },
  items: [
    { kind: 'content_post' as const, userAction: 'approve' as const, phase: 'audience' as const, channel: 'x', scheduledAt: '2026-04-22T17:00:00Z', skillName: 'draft-single-post', params: { anchor_theme: 't' }, title: 'A', description: null },
    { kind: 'content_post' as const, userAction: 'approve' as const, phase: 'audience' as const, channel: 'x', scheduledAt: '2026-04-23T17:00:00Z', skillName: 'draft-single-post', params: { anchor_theme: 't' }, title: 'B', description: null },
    { kind: 'content_post' as const, userAction: 'approve' as const, phase: 'audience' as const, channel: 'x', scheduledAt: '2026-04-24T17:00:00Z', skillName: 'draft-single-post', params: { anchor_theme: 't' }, title: 'C', description: null },
  ],
};

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/product/phase', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const DAY = 86_400_000;

beforeEach(() => {
  allowedRL = true;
  authUserId = 'user-1';
  productRow = null;
  userChannelRows = [];
  txShouldThrow = false;
  runSkillMock.mockReset();
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
  });

  it('returns 404 when user has no product', async () => {
    productRow = null;
    const { POST } = await import('../route');
    const res = await POST(makeReq({ state: 'mvp' }));
    expect(res.status).toBe(404);
  });

  it('returns 400 on invalid_dates (state=launching without launchDate)', async () => {
    productRow = productFixture;
    const { POST } = await import('../route');
    const res = await POST(makeReq({ state: 'launching' }));
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('invalid_dates');
  });

  it('returns 200 success on valid phase change', async () => {
    productRow = productFixture;
    runSkillMock
      .mockResolvedValueOnce({
        results: [validPath],
        errors: [],
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'sonnet', turns: 1 },
      })
      .mockResolvedValueOnce({
        results: [validPlan],
        errors: [],
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'haiku', turns: 1 },
      });

    const { POST } = await import('../route');
    const res = await POST(
      makeReq({
        state: 'launching',
        launchDate: new Date(Date.now() + 30 * DAY).toISOString(),
      }),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      success: boolean;
      strategicPathId: string;
      planId: string;
      items: number;
    };
    expect(payload.success).toBe(true);
    expect(payload.items).toBe(3);
  });

  it('returns 500 when strategic-planner errors', async () => {
    productRow = productFixture;
    runSkillMock.mockResolvedValueOnce({
      results: [],
      errors: [{ label: 's', error: 'LLM refused' }],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'sonnet', turns: 0 },
    });
    const { POST } = await import('../route');
    const res = await POST(makeReq({ state: 'mvp' }));
    expect(res.status).toBe(500);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('replan_failed');
  });

  it('returns 500 when transaction throws', async () => {
    productRow = productFixture;
    txShouldThrow = true;
    runSkillMock
      .mockResolvedValueOnce({
        results: [validPath],
        errors: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'sonnet', turns: 1 },
      })
      .mockResolvedValueOnce({
        results: [validPlan],
        errors: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'haiku', turns: 1 },
      });
    const { POST } = await import('../route');
    const res = await POST(makeReq({ state: 'mvp' }));
    expect(res.status).toBe(500);
  });

  it("feeds the planner the user's connected channels", async () => {
    productRow = productFixture;
    userChannelRows = [{ platform: 'x' }, { platform: 'reddit' }];
    runSkillMock
      .mockResolvedValueOnce({
        results: [validPath],
        errors: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'sonnet', turns: 1 },
      })
      .mockResolvedValueOnce({
        results: [validPlan],
        errors: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'haiku', turns: 1 },
      });
    const { POST } = await import('../route');
    await POST(makeReq({ state: 'mvp' }));

    const strategicCall = runSkillMock.mock.calls[0]?.[0] as {
      input: { channels: string[] };
    };
    const tacticalCall = runSkillMock.mock.calls[1]?.[0] as {
      input: { channels: string[] };
    };
    expect(strategicCall.input.channels).toEqual(['x', 'reddit']);
    expect(tacticalCall.input.channels).toEqual(['x', 'reddit']);
  });

  it("falls back to ['x'] when the user has no connected channels", async () => {
    productRow = productFixture;
    userChannelRows = [];
    runSkillMock
      .mockResolvedValueOnce({
        results: [validPath],
        errors: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'sonnet', turns: 1 },
      })
      .mockResolvedValueOnce({
        results: [validPlan],
        errors: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'haiku', turns: 1 },
      });
    const { POST } = await import('../route');
    await POST(makeReq({ state: 'mvp' }));

    const strategicCall = runSkillMock.mock.calls[0]?.[0] as {
      input: { channels: string[] };
    };
    expect(strategicCall.input.channels).toEqual(['x']);
  });
});
