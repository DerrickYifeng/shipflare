import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { StreamEvent } from '@/core/types';

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

// The route's product lookup runs through db.select() — return a single
// row by default; tests flip productRows = [] to exercise the
// fresh-onboarding (INSERT) path. The strategic_paths lookup reuses the
// same db.select() chain (Drizzle wraps every select the same way), so
// we route by call sequence: first call → products, second call →
// strategic_paths (after the skill resolves). When the route INSERTs a
// products row in the fresh-onboarding branch, productRows is updated
// to mirror the racing/refetch path so a subsequent select picks it up.
let productRows: Array<{ id: string }> = [{ id: 'prod-1' }];
let strategicPathRow: Record<string, unknown> | null = null;
let dbSelectCallCount = 0;

// Insert behavior — tests flip these to drive the resolve-or-insert
// branch. By default a fresh insert returns one row with id 'prod-new-1';
// race tests set insertReturning = [] to mimic onConflictDoNothing
// losing the race, and stage refetchRows for the post-conflict re-select.
let insertReturning: Array<{ id: string }> = [{ id: 'prod-new-1' }];
let lastInsertValues: Record<string, unknown> | null = null;
let dbInsertCallCount = 0;
let refetchRows: Array<{ id: string }> | null = null;

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            dbSelectCallCount += 1;
            // Call 1 → products existence check.
            // Call 2 → optional refetch after onConflictDoNothing race
            //         (only fires when route hits the race branch).
            // Final call → strategic_paths after the skill resolves.
            if (dbSelectCallCount === 1) return productRows;
            if (refetchRows && dbSelectCallCount === 2) return refetchRows;
            return strategicPathRow ? [strategicPathRow] : [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        lastInsertValues = values;
        return {
          onConflictDoNothing: () => ({
            returning: async () => {
              dbInsertCallCount += 1;
              return insertReturning;
            },
          }),
        };
      },
    }),
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return { ...actual, eq: () => ({}) };
});

// runForkSkill is the central seam. Tests configure its behavior via
// `forkSkillBehavior` — fire onEvent callbacks (to test tool_progress
// passthrough), then resolve / reject.
type ForkSkillResult = {
  result: { status: 'completed' | 'failed'; pathId: string; summary: string; notes: string };
};

interface ForkSkillBehavior {
  emitEvents?: StreamEvent[];
  resolve?: ForkSkillResult;
  reject?: Error;
}

let forkSkillBehavior: ForkSkillBehavior = {};

const runForkSkillMock = vi.fn(
  async (
    _skillName: string,
    _args: string,
    _outputSchema: unknown,
    deps: Record<string, unknown>,
  ): Promise<ForkSkillResult> => {
    const onEvent = deps.onEvent as
      | ((event: StreamEvent) => void)
      | undefined;
    if (onEvent && forkSkillBehavior.emitEvents) {
      for (const ev of forkSkillBehavior.emitEvents) {
        onEvent(ev);
      }
    }
    if (forkSkillBehavior.reject) throw forkSkillBehavior.reject;
    return (
      forkSkillBehavior.resolve ?? {
        result: {
          status: 'completed',
          pathId: 'path-1',
          summary: 's',
          notes: 'n',
        },
      }
    );
  },
);
vi.mock('@/skills/run-fork-skill', () => ({
  runForkSkill: (
    skillName: string,
    args: string,
    outputSchema: unknown,
    deps: Record<string, unknown>,
  ) => runForkSkillMock(skillName, args, outputSchema, deps),
}));

// week-bounds is dynamically imported inside the route — mock its module
// path so the import resolves to a deterministic Monday.
vi.mock('@/lib/week-bounds', () => ({
  currentWeekStart: () => new Date('2026-04-27T00:00:00.000Z'),
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
  strategicPathRow = {
    narrative: validPath.narrative,
    milestones: validPath.milestones,
    thesisArc: validPath.thesisArc,
    contentPillars: validPath.contentPillars,
    channelMix: validPath.channelMix,
    phaseGoals: validPath.phaseGoals,
  };
  dbSelectCallCount = 0;
  insertReturning = [{ id: 'prod-new-1' }];
  lastInsertValues = null;
  dbInsertCallCount = 0;
  refetchRows = null;
  forkSkillBehavior = {};
  recordPipelineEventMock.mockClear();
  runForkSkillMock.mockClear();
});

describe('POST /api/onboarding/plan (SSE, direct skill)', () => {
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
    forkSkillBehavior = {
      resolve: {
        result: {
          status: 'completed',
          pathId: 'path-1',
          summary: 'all good',
          notes: 'lean data week 1',
        },
      },
    };

    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const events = await readSSEEvents(res);
    const terminal = events.find((e) => e.type === 'strategic_done');
    expect(terminal).toBeTruthy();
    expect(terminal?.path).toEqual(validPath);

    expect(runForkSkillMock).toHaveBeenCalledTimes(1);
    const [skillName, , , deps] = runForkSkillMock.mock.calls[0]!;
    expect(skillName).toBe('generating-strategy');
    // deps must carry userId / productId / db / onEvent so the fork
    // skill's tools (write_strategic_path etc.) can resolve them.
    expect((deps as Record<string, unknown>).userId).toBe('user-1');
    expect((deps as Record<string, unknown>).productId).toBe('prod-1');
    expect(typeof (deps as Record<string, unknown>).onEvent).toBe('function');

    expect(recordPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'launch_plan_started' }),
    );
    expect(recordPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'launch_plan_completed' }),
    );
  });

  it('INSERTs a products row when the user has none, and uses its id for the skill', async () => {
    productRows = [];
    insertReturning = [{ id: 'prod-new-1' }];
    forkSkillBehavior = {
      resolve: {
        result: {
          status: 'completed',
          pathId: 'path-1',
          summary: 's',
          notes: 'n',
        },
      },
    };

    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    await readSSEEvents(res);

    expect(dbInsertCallCount).toBe(1);
    const [, , , deps] = runForkSkillMock.mock.calls[0]!;
    expect((deps as Record<string, unknown>).productId).toBe('prod-new-1');

    // The INSERT pulls fields from body.product / body.state — confirm
    // the mapping survives any drift in route source.
    expect(lastInsertValues).toMatchObject({
      userId: 'user-1',
      name: validBody.product.name,
      description: validBody.product.description,
      valueProp: validBody.product.valueProp,
      keywords: validBody.product.keywords,
      targetAudience: validBody.product.targetAudience,
      category: validBody.product.category,
      state: validBody.state,
    });
    // onboardingCompletedAt MUST stay unset — the commit route stamps
    // it later when the user finalizes.
    expect(lastInsertValues).not.toHaveProperty('onboardingCompletedAt');
  });

  it('reuses the existing products row when one is present (no INSERT)', async () => {
    productRows = [{ id: 'prod-existing-9' }];
    forkSkillBehavior = {
      resolve: {
        result: {
          status: 'completed',
          pathId: 'path-1',
          summary: 's',
          notes: 'n',
        },
      },
    };

    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    await readSSEEvents(res);

    expect(dbInsertCallCount).toBe(0);
    const [, , , deps] = runForkSkillMock.mock.calls[0]!;
    expect((deps as Record<string, unknown>).productId).toBe('prod-existing-9');
  });

  it('handles concurrent INSERT race via onConflictDoNothing → re-select', async () => {
    // Two browser tabs hit /plan simultaneously. The first wins the
    // INSERT; the second sees existence-check return [] (snapshot was
    // before the first commit), tries to INSERT, and onConflictDoNothing
    // returns []. Route must re-select and use the racing tx's id.
    productRows = [];
    insertReturning = [];
    refetchRows = [{ id: 'prod-race-7' }];
    forkSkillBehavior = {
      resolve: {
        result: {
          status: 'completed',
          pathId: 'path-1',
          summary: 's',
          notes: 'n',
        },
      },
    };

    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    await readSSEEvents(res);

    expect(dbInsertCallCount).toBe(1);
    const [, , , deps] = runForkSkillMock.mock.calls[0]!;
    expect((deps as Record<string, unknown>).productId).toBe('prod-race-7');
  });

  it('streams tool_progress events for each tool the skill calls', async () => {
    // Mirror what runAgent emits: a `tool_start` followed by a
    // `tool_done` for each tool the skill invokes. The route should
    // translate them into `tool_progress` SSE frames before the
    // terminal `strategic_done`.
    forkSkillBehavior = {
      emitEvents: [
        {
          type: 'tool_start',
          toolName: 'query_recent_milestones',
          toolUseId: 'use-1',
          input: {},
        },
        {
          type: 'tool_done',
          toolName: 'query_recent_milestones',
          toolUseId: 'use-1',
          result: {
            tool_use_id: 'use-1',
            content: '[]',
          },
          durationMs: 42,
        },
        {
          type: 'tool_start',
          toolName: 'write_strategic_path',
          toolUseId: 'use-2',
          input: {},
        },
        {
          type: 'tool_done',
          toolName: 'write_strategic_path',
          toolUseId: 'use-2',
          result: {
            tool_use_id: 'use-2',
            content: JSON.stringify({ pathId: 'path-1', persisted: true }),
          },
          durationMs: 117,
        },
      ],
      resolve: {
        result: {
          status: 'completed',
          pathId: 'path-1',
          summary: 's',
          notes: 'n',
        },
      },
    };

    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);

    const events = await readSSEEvents(res);
    const progressEvents = events.filter((e) => e.type === 'tool_progress');

    // At least one tool_progress event lands BEFORE the terminal
    // strategic_done — that's the acceptance criterion.
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    const terminalIdx = events.findIndex((e) => e.type === 'strategic_done');
    const firstProgressIdx = events.findIndex((e) => e.type === 'tool_progress');
    expect(firstProgressIdx).toBeGreaterThanOrEqual(0);
    expect(firstProgressIdx).toBeLessThan(terminalIdx);

    // tool_start translates to phase=start; tool_done to phase=done.
    expect(progressEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_progress',
          phase: 'start',
          toolName: 'query_recent_milestones',
          toolUseId: 'use-1',
        }),
        expect.objectContaining({
          type: 'tool_progress',
          phase: 'done',
          toolName: 'query_recent_milestones',
          toolUseId: 'use-1',
          durationMs: 42,
        }),
        expect.objectContaining({
          type: 'tool_progress',
          phase: 'start',
          toolName: 'write_strategic_path',
          toolUseId: 'use-2',
        }),
        expect.objectContaining({
          type: 'tool_progress',
          phase: 'done',
          toolName: 'write_strategic_path',
          toolUseId: 'use-2',
          durationMs: 117,
        }),
      ]),
    );
  });

  it('emits tool_progress with phase=error when the agent reports an is_error tool result', async () => {
    forkSkillBehavior = {
      emitEvents: [
        {
          type: 'tool_start',
          toolName: 'write_strategic_path',
          toolUseId: 'use-1',
          input: {},
        },
        {
          type: 'tool_done',
          toolName: 'write_strategic_path',
          toolUseId: 'use-1',
          result: {
            tool_use_id: 'use-1',
            content: 'thesisArc length must be >= 4',
            is_error: true,
          },
          durationMs: 12,
        },
      ],
      resolve: {
        result: {
          status: 'completed',
          pathId: 'path-1',
          summary: 's',
          notes: 'n',
        },
      },
    };

    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    const events = await readSSEEvents(res);
    const errorProgress = events.find(
      (e) => e.type === 'tool_progress' && e.phase === 'error',
    );
    expect(errorProgress).toBeTruthy();
    expect(errorProgress?.toolName).toBe('write_strategic_path');
    expect(String(errorProgress?.errorMessage)).toContain('thesisArc');
  });

  it('streams an error event when the skill rejects', async () => {
    forkSkillBehavior = {
      reject: new Error('skill exploded'),
    };
    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);

    const events = await readSSEEvents(res);
    const terminal = events.find((e) => e.type === 'error');
    expect(terminal).toBeTruthy();
    expect(String(terminal?.error)).toContain('skill exploded');

    expect(recordPipelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'launch_plan_failed' }),
    );
  });

  it('streams an error when the skill reports status=failed', async () => {
    forkSkillBehavior = {
      resolve: {
        result: {
          status: 'failed',
          pathId: '',
          summary: '',
          notes: '',
        },
      },
    };
    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);

    const events = await readSSEEvents(res);
    const terminal = events.find((e) => e.type === 'error');
    expect(terminal).toBeTruthy();
    expect(String(terminal?.error)).toContain('status=failed');
  });

  it('streams an error when the persisted strategic_paths row is missing', async () => {
    strategicPathRow = null;
    forkSkillBehavior = {
      resolve: {
        result: {
          status: 'completed',
          pathId: 'path-orphan',
          summary: 's',
          notes: 'n',
        },
      },
    };
    const { POST } = await import('../route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);

    const events = await readSSEEvents(res);
    const terminal = events.find((e) => e.type === 'error');
    expect(terminal).toBeTruthy();
    expect(String(terminal?.error)).toContain('strategic_paths row not found');
  });

  it('rejects an unknown launchChannel value', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      makeRequest({ ...validBody, launchChannel: 'tiktok' }),
    );
    expect(res.status).toBe(400);
  });
});
