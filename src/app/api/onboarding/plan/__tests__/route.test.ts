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
    { atDayOffset: -28, title: 'waitlist', successMetric: 'count >= 100', phase: 'foundation' },
    { atDayOffset: -14, title: 'reply engine shipped', successMetric: '15min window', phase: 'audience' },
    { atDayOffset: -7, title: 'hunters confirmed', successMetric: '5 commits', phase: 'momentum' },
  ],
  thesisArc: [
    { weekStart: '2026-04-20T00:00:00Z', theme: 'ShipFlare thesis', angleMix: ['claim', 'story'] },
  ],
  contentPillars: ['build-in-public', 'solo-dev-ops', 'tooling'],
  channelMix: {
    x: { perWeek: 4, preferredHours: [14, 17, 21] },
  },
  phaseGoals: { audience: 'grow waitlist' },
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/onboarding/plan', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

async function readSSEEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<Record<string, unknown>> = [];
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE messages are separated by \n\n
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      if (!part.startsWith('data: ')) continue;
      const jsonStr = part.slice('data: '.length);
      try {
        events.push(JSON.parse(jsonStr) as Record<string, unknown>);
      } catch {
        // ignore
      }
    }
  }
  return events;
}

beforeEach(() => {
  allowedRL = true;
  authUserId = 'user-1';
  runSkillMock.mockReset();
  recordPipelineEventMock.mockClear();
});

describe('POST /api/onboarding/plan (SSE, strategic-only)', () => {
  it('returns 401 when unauthenticated (not SSE)', async () => {
    authUserId = null;
    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(401);
    expect(res.headers.get('Content-Type')).toBe('application/json');
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

  it('streams strategic_done on success (no tactical run)', async () => {
    runSkillMock.mockResolvedValueOnce({
      results: [validPath],
      errors: [],
      usage: {
        inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
        costUsd: 0.05, model: 'sonnet', turns: 1,
      },
    });

    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const events = await readSSEEvents(res);
    const terminal = events.find((e) => e.type === 'strategic_done');
    expect(terminal).toBeTruthy();
    expect(terminal?.path).toEqual(validPath);

    // runSkill called exactly once — tactical no longer runs here.
    expect(runSkillMock).toHaveBeenCalledTimes(1);

    expect(recordPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'launch_plan_started' }),
    );
    expect(recordPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'launch_plan_completed' }),
    );
  });

  it('streams error event when strategic-planner errors', async () => {
    runSkillMock.mockResolvedValueOnce({
      results: [],
      errors: [{ label: 'strategic', error: 'LLM refused' }],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'sonnet', turns: 0 },
    });
    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);

    const events = await readSSEEvents(res);
    const terminal = events.find((e) => e.type === 'error');
    expect(terminal).toBeTruthy();
    expect(String(terminal?.error)).toContain('strategic-planner error');

    expect(recordPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'launch_plan_failed' }),
    );
  });

  it('forwards launchChannel when state=launching', async () => {
    runSkillMock.mockResolvedValueOnce({
      results: [validPath],
      errors: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'sonnet', turns: 1 },
    });

    const { POST } = await import('../route');
    const res = await POST(
      makeRequest({ ...validBody, launchChannel: 'producthunt' }),
    );
    expect(res.status).toBe(200);

    // Drain the stream so the runSkill call completes.
    await readSSEEvents(res);

    const strategicCall = runSkillMock.mock.calls[0]?.[0] as {
      input: { launchContext: Record<string, unknown> };
    };
    expect(strategicCall.input.launchContext).toEqual({
      launchChannel: 'producthunt',
    });
  });

  it('forwards usersBucket when state=launched', async () => {
    runSkillMock.mockResolvedValueOnce({
      results: [validPath],
      errors: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'sonnet', turns: 1 },
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
    await readSSEEvents(res);

    const strategicCall = runSkillMock.mock.calls[0]?.[0] as {
      input: { launchContext: Record<string, unknown> };
    };
    expect(strategicCall.input.launchContext).toEqual({ usersBucket: '100-1k' });
  });

  it('drops launchChannel when state is not launching', async () => {
    runSkillMock.mockResolvedValueOnce({
      results: [validPath],
      errors: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, model: 'sonnet', turns: 1 },
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
    await readSSEEvents(res);

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
