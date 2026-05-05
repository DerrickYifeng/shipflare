import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks — keep shallow. The commit route does a lot; we're proving the
// validation surface + the call-order invariants, not the drizzle SQL.
// ---------------------------------------------------------------------------

let allowedRL = true;
vi.mock('@/lib/rate-limit', () => ({
  acquireRateLimit: vi.fn(async () => ({
    allowed: allowedRL,
    retryAfterSeconds: allowedRL ? 0 : 5,
  })),
}));

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

// `@/lib/queue` no longer needs mocking here — the onboarding commit
// route does not enqueue any discovery-specific jobs in v3. The rubric
// is generated lazily by the first discovery-scan.

const deleteDraftMock = vi.fn(async () => undefined);
vi.mock('@/lib/onboarding-draft', () => ({
  deleteDraft: deleteDraftMock,
}));

const recordPipelineEventMock = vi.fn(async () => true);
vi.mock('@/lib/pipeline-events', () => ({
  recordPipelineEvent: recordPipelineEventMock,
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

// Kickoff team-run mocks. The route now spawns a coordinator-rooted
// team-run after the transaction commits — these mocks let the happy
// path actually exercise that code instead of relying on the catch.
const ensureTeamExistsMock = vi.fn(async () => ({
  teamId: 'team-1',
  memberIds: {
    coordinator: 'member-coord',
    'content-planner': 'member-planner',
  },
  created: false,
}));
const provisionTeamForProductMock = vi.fn(async () => ({
  teamId: 'team-1',
  preset: 'baseline',
  roster: ['coordinator'],
  created: false,
}));
vi.mock('@/lib/team-provisioner', () => ({
  ensureTeamExists: ensureTeamExistsMock,
  provisionTeamForProduct: provisionTeamForProductMock,
}));

const createAutomationConversationMock = vi.fn(async () => 'conv-1');
vi.mock('@/lib/team-conversation-helpers', () => ({
  createAutomationConversation: createAutomationConversationMock,
}));

const getUserChannelsMock = vi.fn(async () => [] as string[]);
vi.mock('@/lib/user-channels', () => ({
  getUserChannels: getUserChannelsMock,
}));

// db mock — transaction flow returns a stable productId; post-tx
// queries return an empty channels list so calibration path is
// quiet by default.
let prevProduct: Record<string, unknown> | null = null;
let postTxChannels: Array<{ platform: string }> = [];
let txShouldThrow = false;

const selectProductWhere = vi.fn(() => ({
  limit: () => (prevProduct ? [prevProduct] : []),
}));
const selectChannelsWhere = vi.fn(() => postTxChannels);

vi.mock('@/lib/db', () => ({
  db: {
    select: (projection?: unknown) => {
      const sel = projection as Record<string, { name?: string }> | undefined;
      const fields = sel ? Object.keys(sel) : [];
      return {
        from: () => ({
          where: (_cond: unknown) => {
            if (fields.includes('agentType')) {
              // teamMembers lookup for kickoff team-run dispatch.
              return [
                { id: 'member-coord', agentType: 'coordinator' },
                { id: 'member-planner', agentType: 'content-planner' },
              ];
            }
            if (fields.includes('platform')) {
              return selectChannelsWhere();
            }
            return { limit: selectProductWhere };
          },
        }),
      };
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (txShouldThrow) throw new Error('simulated tx failure');
      const tx = {
        insert: () => ({
          values: () => ({
            returning: () => [{ id: 'prod-new-1' }],
          }),
        }),
        update: () => ({ set: () => ({ where: async () => undefined }) }),
      };
      return fn(tx);
    },
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async () => undefined,
      }),
    }),
  },
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validPath = {
  narrative:
    'This is a deliberately long narrative that exceeds the 200-char floor. ' +
    'It names the thesis in paragraph one and sketches the 6-week arc in paragraph two so the downstream fixtures have realistic data to exercise. ' +
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
      kind: 'content_post' as const,
      userAction: 'approve' as const,
      phase: 'audience' as const,
      channel: 'x',
      scheduledAt: '2026-04-22T17:00:00Z',
      skillName: null,
      params: { anchor_theme: 'ShipFlare thesis' },
      title: 'Post 1',
      description: 'desc',
    },
    {
      kind: 'content_post' as const,
      userAction: 'approve' as const,
      phase: 'audience' as const,
      channel: 'x',
      scheduledAt: '2026-04-23T17:00:00Z',
      skillName: null,
      params: { anchor_theme: 'ShipFlare thesis' },
      title: 'Post 2',
      description: 'desc',
    },
    {
      kind: 'content_post' as const,
      userAction: 'approve' as const,
      phase: 'audience' as const,
      channel: 'x',
      scheduledAt: '2026-04-24T17:00:00Z',
      skillName: null,
      params: { anchor_theme: 'ShipFlare thesis' },
      title: 'Post 3',
      description: 'desc',
    },
  ],
};

const TODAY = Date.now();
const DAY = 86_400_000;

function bodyFor(state: 'mvp' | 'launching' | 'launched', dates: { launchDate?: string | null; launchedAt?: string | null } = {}) {
  return {
    product: {
      name: 'ShipFlare',
      description: 'Marketing autopilot for solo devs',
      valueProp: 'Ship without thinking about marketing',
      keywords: ['indiedev', 'buildinpublic'],
      category: 'dev_tool' as const,
      targetAudience: 'Solo founders',
    },
    state,
    launchDate: dates.launchDate ?? null,
    launchedAt: dates.launchedAt ?? null,
    path: validPath,
    plan: validPlan,
  };
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/onboarding/commit', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  allowedRL = true;
  authUserId = 'user-1';
  prevProduct = null;
  postTxChannels = [];
  txShouldThrow = false;
  deleteDraftMock.mockClear();
  recordPipelineEventMock.mockClear();
  ensureTeamExistsMock.mockClear();
  provisionTeamForProductMock.mockClear();
  createAutomationConversationMock.mockClear();
  getUserChannelsMock.mockClear();
});

describe('POST /api/onboarding/commit — auth + rate limit', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { POST } = await import('../route');
    const res = await POST(makeRequest(bodyFor('mvp')));
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate-limited', async () => {
    allowedRL = false;
    const { POST } = await import('../route');
    const res = await POST(makeRequest(bodyFor('mvp')));
    expect(res.status).toBe(429);
  });
});

describe('POST /api/onboarding/commit — date validation', () => {
  it('rejects state=launching without launchDate', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest(bodyFor('launching')));
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('invalid_dates');
  });

  it('accepts state=launching with launchDate today+3d (same-week launch allowed)', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      makeRequest(
        bodyFor('launching', {
          launchDate: new Date(TODAY + 3 * DAY).toISOString(),
        }),
      ),
    );
    expect(res.status).toBe(200);
  });

  it('rejects state=launching with launchDate > today+90d', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      makeRequest(
        bodyFor('launching', {
          launchDate: new Date(TODAY + 120 * DAY).toISOString(),
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  it('accepts state=launching with launchDate in window', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      makeRequest(
        bodyFor('launching', {
          launchDate: new Date(TODAY + 30 * DAY).toISOString(),
        }),
      ),
    );
    expect(res.status).toBe(200);
  });

  it('rejects state=launched without launchedAt', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest(bodyFor('launched')));
    expect(res.status).toBe(400);
  });

  it('rejects state=launched with future launchedAt', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      makeRequest(
        bodyFor('launched', {
          launchedAt: new Date(TODAY + 1 * DAY).toISOString(),
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  it('accepts state=launched with launchedAt in window', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      makeRequest(
        bodyFor('launched', {
          launchedAt: new Date(TODAY - 30 * DAY).toISOString(),
        }),
      ),
    );
    expect(res.status).toBe(200);
  });

  it('rejects state=mvp with launchedAt set', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      makeRequest(
        bodyFor('mvp', {
          launchedAt: new Date(TODAY - 10 * DAY).toISOString(),
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  it('rejects state=mvp with past launchDate', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      makeRequest(
        bodyFor('mvp', {
          launchDate: new Date(TODAY - 5 * DAY).toISOString(),
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  it('accepts state=mvp with launchDate=null', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest(bodyFor('mvp')));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/onboarding/commit — happy path', () => {
  it('returns success=true with productId', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest(bodyFor('mvp')));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { success: boolean; productId: string };
    expect(payload.success).toBe(true);
    expect(payload.productId).toBe('prod-new-1');
  });

  it('does NOT enqueue kickoff at commit time — kickoff fires on first /team visit', async () => {
    // Kickoff moved out of /api/onboarding/commit and into the team page
    // server component (`ensureKickoffEnqueued`). This keeps the
    // commit-time response cheap and lets the AI team work visibly when
    // the founder lands on /team rather than silently while they're
    // still on the onboarding "thanks" screen. The response shape stays
    // backwards-compatible (conversationId field present, just null).
    const { POST } = await import('../route');
    const res = await POST(makeRequest(bodyFor('mvp')));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      conversationId: string | null;
      enqueued: string[];
    };
    expect(payload.conversationId).toBeNull();
    expect(
      payload.enqueued.some((e) => e.startsWith('team-run:kickoff:')),
    ).toBe(false);
    expect(createAutomationConversationMock).not.toHaveBeenCalled();
    // Phase G cleanup (migration 0016_drop_team_runs): the legacy
    // `enqueueTeamRun` helper has been deleted; this test used to
    // assert it wasn't called. Kickoff dispatch now flows through
    // team-kickoff.ts → dispatchLeadMessage, mocked out separately
    // above (provisionTeamForProductMock) so this branch is still a
    // no-op as far as kickoff is concerned.
  });

  it('clears the Redis draft after a successful commit', async () => {
    const { POST } = await import('../route');
    await POST(makeRequest(bodyFor('mvp')));
    expect(deleteDraftMock).toHaveBeenCalledWith('user-1');
  });

  it('records a launch_plan_completed pipeline event with kind=commit', async () => {
    const { POST } = await import('../route');
    await POST(makeRequest(bodyFor('mvp')));
    expect(recordPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'launch_plan_completed',
        userId: 'user-1',
      }),
    );
  });

  // Discovery v3: legacy calibration-enqueue tests removed. The rubric
  // is generated lazily on the first discovery-scan, so onboarding no
  // longer fires a calibration job.

  it('accepts launchChannel/usersBucket and records them on the pipeline event', async () => {
    const { POST } = await import('../route');
    const body = {
      ...bodyFor('launching', { launchDate: new Date(Date.now() + 14 * 86_400_000).toISOString() }),
      launchChannel: 'showhn',
      usersBucket: '1k-10k',
    };
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    expect(recordPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'launch_plan_completed',
        metadata: expect.objectContaining({
          launchChannel: 'showhn',
          usersBucket: '1k-10k',
        }),
      }),
    );
  });

  it('rejects an unknown launchChannel value', async () => {
    const { POST } = await import('../route');
    const body = {
      ...bodyFor('launching', { launchDate: new Date(Date.now() + 14 * 86_400_000).toISOString() }),
      launchChannel: 'tiktok',
    };
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/onboarding/commit — path-only (plan deferred to team-run)', () => {
  it('accepts a body without `plan` and returns 200 without enqueueing a planner job', async () => {
    // Phase C: tactical-generate is gone. plan_items are written by the
    // team-run already in flight from POST /api/onboarding/plan, so commit
    // only persists the strategic path + plans header row.
    const { POST } = await import('../route');
    const body = bodyFor('mvp') as Record<string, unknown>;
    delete body.plan;
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      success: boolean;
      productId: string;
      enqueued: string[];
      tacticalJobId?: string;
    };
    expect(payload.success).toBe(true);
    expect(payload.tacticalJobId).toBeUndefined();
    expect(payload.enqueued.some((e) => e.startsWith('tactical-generate:'))).toBe(
      false,
    );
  });

  it('accepts `plan` inline when present (back-compat)', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest(bodyFor('mvp')));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { tacticalJobId?: string };
    expect(payload.tacticalJobId).toBeUndefined();
  });
});

describe('POST /api/onboarding/commit — failure paths', () => {
  it('returns 500 when the transaction throws', async () => {
    txShouldThrow = true;
    const { POST } = await import('../route');
    const res = await POST(makeRequest(bodyFor('mvp')));
    expect(res.status).toBe(500);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('commit_failed');
  });
});
