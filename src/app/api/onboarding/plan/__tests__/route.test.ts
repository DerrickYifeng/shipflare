import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

let allowedRL = true;

vi.mock('@/lib/rate-limit', () => ({
  acquireRateLimit: vi.fn(async () => ({
    allowed: allowedRL,
    retryAfterSeconds: allowedRL ? 0 : 7,
  })),
}));

const recordPipelineEventMock = vi.fn(async () => true);
vi.mock('@/lib/pipeline-events', () => ({
  recordPipelineEvent: recordPipelineEventMock,
}));

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () =>
    authUserId ? { user: { id: authUserId } } : null,
}));

// Skill loader is called at module init — stub to a tiny marker so the
// route file can import without hitting the filesystem.
vi.mock('@/core/skill-loader', () => ({
  loadSkill: (path: string) => ({ name: path.includes('strategic') ? 'strategic-planner' : 'tactical-planner' }),
}));

// runSkill is the workhorse — each test primes the next result.
const runSkillMock = vi.fn();
vi.mock('@/core/skill-runner', () => ({
  runSkill: runSkillMock,
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

// SKILL_CATALOG is shared across all skills but only read shallowly here.
vi.mock('@/skills/_catalog', () => ({
  SKILL_CATALOG: [],
}));

const validBody = {
  product: {
    name: 'ShipFlare',
    description: 'Marketing autopilot for solo devs.',
    valueProp: 'Ship marketing without thinking about marketing.',
    keywords: ['buildinpublic', 'indiedev'],
    category: 'dev_tool',
    targetAudience: 'Solo founders shipping weekly.',
  },
  channels: ['x', 'email'],
  state: 'launching',
  launchDate: '2026-05-14T00:00:00.000Z',
  launchedAt: null,
  recentMilestones: [],
  voiceProfile: null,
};

const validPath = {
  narrative:
    'This is a deliberately long narrative that exceeds the 200-char floor. ' +
    'It names the thesis in paragraph one and sketches the 6-week arc in paragraph two so the downstream test fixtures have realistic data to exercise. ' +
    'We hedge by calling out one risk — overposting before launch — and the mitigation approach.',
  milestones: [
    {
      atDayOffset: -28,
      title: 'waitlist',
      successMetric: 'count >= 100',
      phase: 'foundation',
    },
    {
      atDayOffset: -14,
      title: 'reply engine shipped',
      successMetric: '15min window',
      phase: 'audience',
    },
    {
      atDayOffset: -7,
      title: 'hunters confirmed',
      successMetric: '5 commits',
      phase: 'momentum',
    },
  ],
  thesisArc: [
    {
      weekStart: '2026-04-20T00:00:00Z',
      theme: 'ShipFlare thesis',
      angleMix: ['claim', 'story'],
    },
  ],
  contentPillars: ['build-in-public', 'solo-dev-ops', 'tooling'],
  channelMix: {
    x: { perWeek: 4, preferredHours: [14, 17, 21] },
  },
  phaseGoals: { audience: 'grow waitlist' },
};

const validPlan = {
  plan: { thesis: 'ShipFlare thesis', notes: 'week notes' },
  items: [
    {
      kind: 'content_post',
      userAction: 'approve',
      phase: 'audience',
      channel: 'x',
      scheduledAt: '2026-04-22T17:00:00Z',
      skillName: 'draft-single-post',
      params: { anchor_theme: 'ShipFlare thesis' },
      title: 'Post 1',
      description: 'desc',
    },
    {
      kind: 'content_post',
      userAction: 'approve',
      phase: 'audience',
      channel: 'x',
      scheduledAt: '2026-04-23T17:00:00Z',
      skillName: 'draft-single-post',
      params: { anchor_theme: 'ShipFlare thesis' },
      title: 'Post 2',
      description: 'desc',
    },
    {
      kind: 'content_post',
      userAction: 'approve',
      phase: 'audience',
      channel: 'x',
      scheduledAt: '2026-04-24T17:00:00Z',
      skillName: 'draft-single-post',
      params: { anchor_theme: 'ShipFlare thesis' },
      title: 'Post 3',
      description: 'desc',
    },
  ],
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/onboarding/plan', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  allowedRL = true;
  authUserId = 'user-1';
  runSkillMock.mockReset();
  recordPipelineEventMock.mockClear();
});

describe('POST /api/onboarding/plan', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate-limited', async () => {
    allowedRL = false;
    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('7');
  });

  it('returns 400 on invalid body', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ product: {} }));
    expect(res.status).toBe(400);
  });

  it('returns { path, plan } on success', async () => {
    runSkillMock
      .mockResolvedValueOnce({
        results: [validPath],
        errors: [],
        usage: {
          inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
          costUsd: 0.05, model: 'sonnet', turns: 1,
        },
      })
      .mockResolvedValueOnce({
        results: [validPlan],
        errors: [],
        usage: {
          inputTokens: 2000, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0,
          costUsd: 0.01, model: 'haiku', turns: 1,
        },
      });

    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { path: unknown; plan: unknown };
    expect(payload.path).toEqual(validPath);
    expect(payload.plan).toEqual(validPlan);
    expect(runSkillMock).toHaveBeenCalledTimes(2);
    expect(recordPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'launch_plan_started' }),
    );
    expect(recordPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'launch_plan_completed' }),
    );
  });

  it('returns 500 when strategic-planner errors', async () => {
    runSkillMock.mockResolvedValueOnce({
      results: [],
      errors: [{ label: 'strategic', error: 'LLM refused' }],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'sonnet', turns: 0 },
    });
    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(500);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('planner_failed');
    expect(recordPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'launch_plan_failed' }),
    );
  });

  it('accepts launchChannel when state=launching and forwards it to the planner', async () => {
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
    const res = await POST(
      makeRequest({ ...validBody, launchChannel: 'producthunt' }),
    );
    expect(res.status).toBe(200);

    const strategicCall = runSkillMock.mock.calls[0]?.[0] as {
      input: { launchContext: Record<string, unknown> };
    };
    expect(strategicCall.input.launchContext).toEqual({
      launchChannel: 'producthunt',
    });
    // pipeline event carries the hint for observability
    expect(recordPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'launch_plan_started',
        metadata: expect.objectContaining({ launchChannel: 'producthunt' }),
      }),
    );
  });

  it('accepts usersBucket when state=launched and forwards it', async () => {
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
    const res = await POST(
      makeRequest({
        ...validBody,
        state: 'launched',
        launchDate: null,
        launchedAt: '2026-04-01T00:00:00.000Z',
        usersBucket: '100-1k',
      }),
    );
    expect(res.status).toBe(200);

    const strategicCall = runSkillMock.mock.calls[0]?.[0] as {
      input: { launchContext: Record<string, unknown> };
    };
    expect(strategicCall.input.launchContext).toEqual({ usersBucket: '100-1k' });
  });

  it('drops launchChannel when state is not launching', async () => {
    // state=mvp + launchChannel should NOT forward the hint — the planner
    // prompt only uses it for the launching phase.
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
    const res = await POST(
      makeRequest({
        ...validBody,
        state: 'mvp',
        launchDate: null,
        launchedAt: null,
        launchChannel: 'producthunt',
      }),
    );
    expect(res.status).toBe(200);

    const strategicCall = runSkillMock.mock.calls[0]?.[0] as {
      input: { launchContext: Record<string, unknown> };
    };
    expect(strategicCall.input.launchContext).toEqual({});
  });

  it('rejects an unknown launchChannel value', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      makeRequest({ ...validBody, launchChannel: 'tiktok' }),
    );
    expect(res.status).toBe(400);
  });
});
