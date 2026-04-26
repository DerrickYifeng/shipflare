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

// Phase C: the route always routes through team-run. The DB mock returns
// one product row so the route passes productId to ensureTeamExists; the
// productId=null path is exercised by changing `productRows` to [].
let productRows: Array<{ id: string }> = [{ id: 'prod-1' }];
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => productRows,
        }),
      }),
    }),
    // Chat refactor: onboarding route mints a fresh conversation via
    // createAutomationConversation so the team-run has somewhere to
    // hang messages. Mock just returns a fixed id.
    insert: () => ({
      values: () => ({
        returning: () => [{ id: 'conv-onboarding-test' }],
      }),
    }),
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return { ...actual, eq: () => ({}) };
});

const ensureTeamExistsMock = vi.fn(
  async (_userId: string, _productId: string | null) => ({
    teamId: 'team-1',
    memberIds: {
      coordinator: 'mem-coord',
      'growth-strategist': 'mem-gs',
      'content-planner': 'mem-cp',
    },
    created: false,
  }),
);
vi.mock('@/lib/team-provisioner', () => ({
  ensureTeamExists: (userId: string, productId: string | null) =>
    ensureTeamExistsMock(userId, productId),
}));

const enqueueTeamRunMock = vi.fn(async (_input: Record<string, unknown>) => ({
  runId: 'run-1',
  traceId: 'trace-1',
  alreadyRunning: false,
}));
vi.mock('@/lib/queue/team-run', () => ({
  enqueueTeamRun: (input: Record<string, unknown>) => enqueueTeamRunMock(input),
}));

// subscribeToStrategicPathEvents yields whatever events we push. Tests
// seed the event queue via `pushEvent`.
type OnboardingEvent =
  | { type: 'heartbeat' }
  | { type: 'error'; error: string }
  | { type: 'strategic_done'; path: Record<string, unknown> };
let pendingEvents: OnboardingEvent[] = [];
vi.mock('@/lib/onboarding-team-run', () => ({
  subscribeToStrategicPathEvents: async function* (
    _teamId: string,
    _runId: string,
  ): AsyncGenerator<OnboardingEvent, void, void> {
    for (const e of pendingEvents) yield e;
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  productRows = [{ id: 'prod-1' }];
  pendingEvents = [];
  recordPipelineEventMock.mockClear();
  ensureTeamExistsMock.mockClear();
  enqueueTeamRunMock.mockClear();
});

describe('POST /api/onboarding/plan (SSE, team-run only)', () => {
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

  it('streams strategic_done on success', async () => {
    pendingEvents = [{ type: 'strategic_done', path: validPath }];

    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const events = await readSSEEvents(res);
    const terminal = events.find((e) => e.type === 'strategic_done');
    expect(terminal).toBeTruthy();
    expect(terminal?.path).toEqual(validPath);

    expect(ensureTeamExistsMock).toHaveBeenCalledWith('user-1', 'prod-1');
    expect(enqueueTeamRunMock).toHaveBeenCalledTimes(1);
    expect(enqueueTeamRunMock.mock.calls[0]?.[0]).toMatchObject({
      teamId: 'team-1',
      trigger: 'onboarding',
      // onboarding is rooted at growth-strategist (not coordinator) so the
      // run writes strategic_path directly without a delegation turn.
      rootMemberId: 'mem-gs',
    });

    expect(recordPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'launch_plan_started' }),
    );
    expect(recordPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'launch_plan_completed' }),
    );
  });

  it('passes productId=null when no product row exists (fresh onboarding)', async () => {
    productRows = [];
    pendingEvents = [{ type: 'strategic_done', path: validPath }];

    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    await readSSEEvents(res);

    expect(ensureTeamExistsMock).toHaveBeenCalledWith('user-1', null);
  });

  it('streams error event when the team-run reports an error', async () => {
    pendingEvents = [{ type: 'error', error: 'coordinator crashed' }];
    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);

    const events = await readSSEEvents(res);
    const terminal = events.find((e) => e.type === 'error');
    expect(terminal).toBeTruthy();
    expect(String(terminal?.error)).toContain('coordinator crashed');

    expect(recordPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'launch_plan_failed' }),
    );
  });

  it('streams error when the team-run ends without a strategic path', async () => {
    pendingEvents = [];
    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);

    const events = await readSSEEvents(res);
    const terminal = events.find((e) => e.type === 'error');
    expect(terminal).toBeTruthy();
    expect(String(terminal?.error)).toContain('team-run ended without a strategic path');
  });

  it('rejects an unknown launchChannel value', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      makeRequest({ ...validBody, launchChannel: 'tiktok' }),
    );
    expect(res.status).toBe(400);
  });

  it('includes product category + phase + milestones in the coordinator goal', async () => {
    pendingEvents = [{ type: 'strategic_done', path: validPath }];
    const body = {
      ...validBody,
      recentMilestones: [
        {
          title: 'reply engine shipped',
          summary: 'reply window tightened to 15 minutes',
          source: 'pr',
          atISO: '2026-04-19T21:30:00Z',
        },
      ],
    };
    const { POST } = await import('../route');
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    await readSSEEvents(res);

    const goal = enqueueTeamRunMock.mock.calls[0]?.[0]?.goal as string;
    expect(goal).toContain('ShipFlare');
    expect(goal).toContain('dev_tool');
    expect(goal).toContain('launching');
    expect(goal).toContain('audience'); // phase derived from launchDate
    expect(goal).toContain('reply engine shipped');
  });
});
