/**
 * Route test for /api/today/progress. Verifies the team-run-derivation
 * of the tactical snapshot post-Phase-E (the old plans/plan_items path
 * was deleted in Phase C — see tactical-progress-card.tsx header for
 * context).
 *
 * The route runs DB queries via loadTacticalStatus:
 *     1. teams                       (find the user's team — id only)
 *     2. team_messages               (most-recent tactical wake msg
 *                                     within 24h, by metadata.trigger)
 *     3. agent_runs                  (lead's status — agentDefName=
 *                                     'coordinator')
 *     4. team_messages               (terminal completion/error event
 *                                     newer than the wake message)
 *     5. team_messages COUNT         (# of add_plan_item tool_calls)
 *
 * We stub the drizzle `db.select()` chain to dispatch on the projection
 * keys (each query has a distinctive shape) so the test stays declarative.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

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
    traceId: 'test-trace',
  }),
}));

// ---------------------------------------------------------------------------
// Shared state — mutated in beforeEach + individual tests
// ---------------------------------------------------------------------------

interface State {
  teamRows: Array<{ id: string }>;
  /** The latest tactical wake message (or empty if none in window). */
  latestTacticalMsg: Array<{ id: string; createdAt: Date }>;
  /** The lead's agent_runs row (or empty if none yet). */
  leadStatus: Array<{
    status: string;
    lastActiveAt: Date;
  }>;
  /** Optional terminal completion/error team_messages row. */
  terminalEvent: Array<{
    type: string;
    content: string | null;
    createdAt: Date;
  }>;
  addPlanItemCount: number;
}

const state: State = {
  teamRows: [],
  latestTacticalMsg: [],
  leadStatus: [],
  terminalEvent: [],
  addPlanItemCount: 0,
};

// ---------------------------------------------------------------------------
// DB select mock
// ---------------------------------------------------------------------------

/**
 * Builds a thenable that supports:
 *   - direct await                         (.then)
 *   - .orderBy().limit()                   (teams / messages chains)
 *   - .limit()                             (limit-only chain)
 */
function thenable<T>(rows: T): {
  orderBy: () => { limit: () => Promise<T> };
  limit: () => Promise<T>;
  then: Promise<T>['then'];
} {
  const promise = Promise.resolve(rows);
  return Object.assign(
    {
      orderBy: () => ({
        limit: () => Promise.resolve(rows),
      }),
      limit: () => Promise.resolve(rows),
      then: promise.then.bind(promise),
    },
    {},
  );
}

vi.mock('@/lib/db', () => ({
  db: {
    select: (projection: Record<string, unknown>) => {
      const keys = Object.keys(projection).sort().join(',');
      return {
        from: () => ({
          where: () => {
            // Count query → single `n` column
            if (keys === 'n') {
              return thenable([{ n: state.addPlanItemCount }]);
            }

            // Single-`id` projection → teams
            if (keys === 'id') {
              return thenable(state.teamRows);
            }

            // Latest-tactical-msg projection: { id, createdAt }
            if (keys === 'createdAt,id') {
              return thenable(state.latestTacticalMsg);
            }

            // Lead status projection: { status, lastActiveAt }
            if (keys === 'lastActiveAt,status') {
              return thenable(state.leadStatus);
            }

            // Terminal event projection: { type, content, createdAt }
            if (keys === 'content,createdAt,type') {
              return thenable(state.terminalEvent);
            }

            throw new Error(
              `Unexpected select projection: ${JSON.stringify(Object.keys(projection))}`,
            );
          },
        }),
      };
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
    inArray: () => ({}),
    desc: () => ({}),
    count: () => ({}),
    sql: Object.assign(
      (..._args: unknown[]) => ({ mapWith: () => ({}) }),
      { raw: () => ({}) },
    ),
  };
});

function makeRequest(): NextRequest {
  // Minimal NextRequest stand-in — the route only reads the URL for logging.
  return new NextRequest(new URL('http://test.local/api/today/progress'));
}

beforeEach(() => {
  authUserId = 'user-1';
  state.teamRows = [];
  state.latestTacticalMsg = [];
  state.leadStatus = [];
  state.terminalEvent = [];
  state.addPlanItemCount = 0;
});

describe('GET /api/today/progress', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { GET } = await import('../route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns tactical=pending + teamRun=null when the user has no team', async () => {
    state.teamRows = [];
    const { GET } = await import('../route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tactical.status).toBe('pending');
    expect(body.tactical.itemCount).toBe(0);
    expect(body.teamRun).toBeNull();
  });

  it('returns tactical=pending + teamRun=null when no recent tactical wake message exists', async () => {
    state.teamRows = [{ id: 'team-1' }];
    state.latestTacticalMsg = [];
    const { GET } = await import('../route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.tactical.status).toBe('pending');
    expect(body.teamRun).toBeNull();
  });

  it('returns tactical=running when lead agent_runs status is running', async () => {
    state.teamRows = [{ id: 'team-1' }];
    state.latestTacticalMsg = [{ id: 'msg-1', createdAt: new Date() }];
    state.leadStatus = [{ status: 'running', lastActiveAt: new Date() }];
    state.terminalEvent = [];
    state.addPlanItemCount = 3;
    const { GET } = await import('../route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.tactical.status).toBe('running');
    expect(body.tactical.itemCount).toBe(3);
    expect(body.teamRun).toEqual({ teamId: 'team-1', runId: 'msg-1' });
    expect(body.tactical.planId).toBe('msg-1');
  });

  it('returns tactical=running when lead agent_runs status is resuming', async () => {
    state.teamRows = [{ id: 'team-1' }];
    state.latestTacticalMsg = [{ id: 'msg-1a', createdAt: new Date() }];
    state.leadStatus = [{ status: 'resuming', lastActiveAt: new Date() }];
    state.terminalEvent = [];
    const { GET } = await import('../route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.tactical.status).toBe('running');
    expect(body.teamRun).toEqual({ teamId: 'team-1', runId: 'msg-1a' });
  });

  it('returns tactical=completed (fresh) when lead is sleeping with recent lastActiveAt', async () => {
    state.teamRows = [{ id: 'team-1' }];
    state.latestTacticalMsg = [
      { id: 'msg-2', createdAt: new Date(Date.now() - 2 * 60_000) },
    ];
    state.leadStatus = [
      {
        status: 'sleeping',
        lastActiveAt: new Date(Date.now() - 60_000),
      },
    ];
    state.terminalEvent = [];
    state.addPlanItemCount = 5;
    const { GET } = await import('../route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.tactical.status).toBe('completed');
    expect(body.tactical.itemCount).toBe(5);
    expect(body.teamRun).toEqual({ teamId: 'team-1', runId: 'msg-2' });
  });

  it('returns tactical=pending when sleeping lead lastActiveAt is older than 5 min (stale success)', async () => {
    state.teamRows = [{ id: 'team-1' }];
    state.latestTacticalMsg = [
      { id: 'msg-3', createdAt: new Date(Date.now() - 30 * 60_000) },
    ];
    state.leadStatus = [
      {
        status: 'sleeping',
        lastActiveAt: new Date(Date.now() - 20 * 60_000),
      },
    ];
    state.terminalEvent = [];
    state.addPlanItemCount = 7;
    const { GET } = await import('../route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.tactical.status).toBe('pending');
    expect(body.teamRun).toBeNull();
  });

  it('returns tactical=failed when a terminal error team_messages row exists', async () => {
    state.teamRows = [{ id: 'team-1' }];
    state.latestTacticalMsg = [
      { id: 'msg-4', createdAt: new Date(Date.now() - 5 * 60_000) },
    ];
    state.leadStatus = [
      { status: 'sleeping', lastActiveAt: new Date(Date.now() - 60_000) },
    ];
    state.terminalEvent = [
      {
        type: 'error',
        content: 'coordinator exhausted turns',
        createdAt: new Date(),
      },
    ];
    state.addPlanItemCount = 2;
    const { GET } = await import('../route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.tactical.status).toBe('failed');
    expect(body.tactical.error).toBe('coordinator exhausted turns');
    expect(body.tactical.itemCount).toBe(2);
    expect(body.teamRun).toEqual({ teamId: 'team-1', runId: 'msg-4' });
  });

  it('returns tactical=completed (fresh) when a terminal completion team_messages row exists', async () => {
    state.teamRows = [{ id: 'team-1' }];
    state.latestTacticalMsg = [
      { id: 'msg-5', createdAt: new Date(Date.now() - 2 * 60_000) },
    ];
    state.leadStatus = [
      { status: 'sleeping', lastActiveAt: new Date(Date.now() - 30_000) },
    ];
    state.terminalEvent = [
      {
        type: 'completion',
        content: '',
        createdAt: new Date(Date.now() - 30_000),
      },
    ];
    state.addPlanItemCount = 4;
    const { GET } = await import('../route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.tactical.status).toBe('completed');
    expect(body.teamRun).toEqual({ teamId: 'team-1', runId: 'msg-5' });
  });
});
