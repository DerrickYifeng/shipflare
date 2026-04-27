/**
 * Route test for /api/today/progress. Verifies the new team-run-based
 * derivation of the tactical snapshot (the old plans/plan_items path was
 * deleted in Phase C — see tactical-progress-card.tsx header for context).
 *
 * The route runs DB queries via Promise.all:
 *   loadTacticalStatus:
 *     1. teams                  (find the user's team — id only, orderBy+limit)
 *     2. team_runs              (most-recent tactical run within 24h)
 *     3. team_messages COUNT    (# of add_plan_item tool_calls)
 *   loadCalibrationState:
 *     4. channels               (connected platforms — platform only)
 *     5. products               (user's product id — id only, limit without orderBy)
 *
 * We stub the drizzle `db.select()` chain to dispatch on the projection
 * keys (each query has a distinctive shape) so the test stays declarative.
 * For the two single-`id` projections (teams vs products), we use a call
 * counter because teams is always fetched first (from loadTacticalStatus)
 * and products second (from loadCalibrationState). Both halves run inside
 * Promise.all, but JS microtask ordering ensures the synchronous dispatch
 * sequence is stable within a single event-loop turn.
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
  channelRows: Array<{ platform: string }>;
  productRows: Array<{ id: string }>;
  /**
   * MemoryStore.loadEntry mock: keyed by entry name, returns null or the
   * entry's content string. Set to null to simulate a cache miss.
   */
  memoryEntries: Map<string, string | null>;
}

const state: State = {
  teamRows: [],
  runRows: [],
  addPlanItemCount: 0,
  channelRows: [],
  productRows: [],
  memoryEntries: new Map(),
};

// ---------------------------------------------------------------------------
// MemoryStore mock — must be declared before the route import
// ---------------------------------------------------------------------------

vi.mock('@/memory/store', () => ({
  MemoryStore: class {
    loadEntry(name: string) {
      const content = state.memoryEntries.get(name);
      if (content === undefined || content === null) {
        return Promise.resolve(null);
      }
      return Promise.resolve({ name, content });
    }
  },
}));

vi.mock('@/tools/CalibrateSearchTool/strategy-memory', () => ({
  searchStrategyMemoryName: (platform: string) => `${platform}-search-strategy`,
}));

// ---------------------------------------------------------------------------
// DB select mock
// ---------------------------------------------------------------------------

// Track how many times the single-`id` projection has been called so we can
// distinguish the teams query (1st call) from the products query (2nd call).
let idProjectionCallCount = 0;

/**
 * Builds a thenable that supports:
 *   - direct await                         (.then)
 *   - .orderBy().limit()                   (teams / runs chain)
 *   - .limit()                             (products chain — no orderBy)
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

            // Channels query → `platform` only
            if (keys.length === 1 && keys[0] === 'platform') {
              return thenable(state.channelRows);
            }

            // Single-`id` projection: teams (1st call) or products (2nd call).
            // Teams comes from loadTacticalStatus, products from
            // loadCalibrationState; both are launched by Promise.all in
            // buildSnapshot, but teams resolves its synchronous dispatch first.
            if (keys.length === 1 && keys[0] === 'id') {
              const isTeams = idProjectionCallCount === 0;
              idProjectionCallCount += 1;
              return thenable(isTeams ? state.teamRows : state.productRows);
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
  state.channelRows = [];
  state.productRows = [];
  state.memoryEntries = new Map();
  idProjectionCallCount = 0;
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

  it('returns calibration.platforms with status=pending when no strategy is cached', async () => {
    state.teamRows = [{ id: 'team-1' }];
    state.runRows = [];
    state.channelRows = [{ platform: 'x' }];
    state.productRows = [{ id: 'p1' }];
    // No memoryEntries set → loadEntry returns null → status='pending'
    const { GET } = await import('../route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.calibration.platforms).toEqual([
      { platform: 'x', status: 'pending', precision: null, round: 0 },
    ]);
  });

  it('returns calibration.platforms with status=completed when a strategy is cached', async () => {
    state.teamRows = [{ id: 'team-1' }];
    state.runRows = [];
    state.channelRows = [{ platform: 'x' }];
    state.productRows = [{ id: 'p1' }];
    state.memoryEntries.set(
      'x-search-strategy',
      JSON.stringify({
        platform: 'x',
        schemaVersion: 2,
        generatedAt: '2026-04-26T00:00:00.000Z',
        queries: ['q1'],
        observedPrecision: 0.82,
        reachedTarget: true,
        turnsUsed: 8,
        sampleSize: 24,
      }),
    );
    const { GET } = await import('../route');
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.calibration.platforms).toEqual([
      { platform: 'x', status: 'completed', precision: 0.82, round: 0 },
    ]);
  });
});
