/**
 * Route test for /api/today/progress. Verifies the team-run-based
 * derivation of the tactical snapshot (the old plans/plan_items path was
 * deleted in Phase C — see tactical-progress-card.tsx header for context).
 *
 * The route runs DB queries via loadTacticalStatus:
 *     1. teams                  (find the user's team — id only, orderBy+limit)
 *     2. team_runs              (most-recent tactical run within 24h)
 *     3. team_messages COUNT    (# of add_plan_item tool_calls)
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
  runRows: Array<{
    id: string;
    status: string;
    completedAt: Date | null;
    errorMessage: string | null;
  }>;
  addPlanItemCount: number;
}

const state: State = {
  teamRows: [],
  runRows: [],
  addPlanItemCount: 0,
};

// ---------------------------------------------------------------------------
// DB select mock
// ---------------------------------------------------------------------------

/**
 * Builds a thenable that supports:
 *   - direct await                         (.then)
 *   - .orderBy().limit()                   (teams / runs chain)
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
      const keys = Object.keys(projection);
      return {
        from: () => ({
          where: () => {
            // Count query → single `n` column
            if (keys.length === 1 && keys[0] === 'n') {
              return thenable([{ n: state.addPlanItemCount }]);
            }

            // Single-`id` projection → teams
            if (keys.length === 1 && keys[0] === 'id') {
              return thenable(state.teamRows);
            }

            // team_runs query → has `status`, `completedAt`, etc.
            if (keys.includes('status') && keys.includes('completedAt')) {
              return thenable(state.runRows);
            }

            throw new Error(
              `Unexpected select projection: ${JSON.stringify(keys)}`,
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
  state.runRows = [];
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

  it('returns tactical=pending + teamRun=null when the team has no recent run', async () => {
    state.teamRows = [{ id: 'team-1' }];
    state.runRows = [];
    const { GET } = await import('../route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.tactical.status).toBe('pending');
    expect(body.teamRun).toBeNull();
  });

  it('returns tactical=running with teamRun ref when a team_run is running', async () => {
    state.teamRows = [{ id: 'team-1' }];
    state.runRows = [
      {
        id: 'run-1',
        status: 'running',
        completedAt: null,
        errorMessage: null,
      },
    ];
    state.addPlanItemCount = 3;
    const { GET } = await import('../route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.tactical.status).toBe('running');
    expect(body.tactical.itemCount).toBe(3);
    expect(body.teamRun).toEqual({ teamId: 'team-1', runId: 'run-1' });
    expect(body.tactical.planId).toBe('run-1');
  });

  it('returns tactical=completed (fresh) within 5 min of completedAt', async () => {
    state.teamRows = [{ id: 'team-1' }];
    state.runRows = [
      {
        id: 'run-2',
        status: 'completed',
        completedAt: new Date(Date.now() - 60_000),
        errorMessage: null,
      },
    ];
    state.addPlanItemCount = 5;
    const { GET } = await import('../route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.tactical.status).toBe('completed');
    expect(body.tactical.itemCount).toBe(5);
    expect(body.teamRun).toEqual({ teamId: 'team-1', runId: 'run-2' });
  });

  it('returns tactical=pending when completedAt is older than 5 min (stale success)', async () => {
    state.teamRows = [{ id: 'team-1' }];
    state.runRows = [
      {
        id: 'run-3',
        status: 'completed',
        completedAt: new Date(Date.now() - 20 * 60_000),
        errorMessage: null,
      },
    ];
    state.addPlanItemCount = 7;
    const { GET } = await import('../route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.tactical.status).toBe('pending');
    expect(body.teamRun).toBeNull();
  });

  it('returns tactical=failed with the team_run error message', async () => {
    state.teamRows = [{ id: 'team-1' }];
    state.runRows = [
      {
        id: 'run-4',
        status: 'failed',
        completedAt: new Date(),
        errorMessage: 'coordinator exhausted turns',
      },
    ];
    state.addPlanItemCount = 2;
    const { GET } = await import('../route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.tactical.status).toBe('failed');
    expect(body.tactical.error).toBe('coordinator exhausted turns');
    expect(body.tactical.itemCount).toBe(2);
    expect(body.teamRun).toEqual({ teamId: 'team-1', runId: 'run-4' });
  });
});
