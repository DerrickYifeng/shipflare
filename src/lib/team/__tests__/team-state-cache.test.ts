import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getTeamState,
  invalidateTeamState,
  writeTeamStateField,
  type TeamState,
  TEAM_STATE_TTL_SECONDS,
  teamStateKey,
} from '@/lib/team/team-state-cache';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface FakeRedis {
  store: Map<string, string>;
  get: ReturnType<typeof vi.fn>;
  setex: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
}

function makeRedis(initial: Record<string, string> = {}): FakeRedis {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    }),
  };
}

function makeFailingRedis(): FakeRedis {
  return {
    store: new Map(),
    get: vi.fn(async () => {
      throw new Error('redis offline');
    }),
    setex: vi.fn(async () => {
      throw new Error('redis offline');
    }),
    del: vi.fn(async () => {
      throw new Error('redis offline');
    }),
  };
}

interface DbScenario {
  leadRows?: Array<{
    id: string;
    status: string;
    lastActiveAt: Date | null;
  }>;
  teammateRows?: Array<{
    agentId: string;
    memberId: string;
    agentDefName: string;
    parentAgentId: string | null;
    status: string;
    lastActiveAt: Date | null;
    sleepUntil: Date | null;
    displayName: string;
  }>;
  /** Optional spy invoked once per `db.select(...)` call. Useful for
   *  asserting the cache-hit path skipped the DB entirely. */
  onSelect?: (...args: unknown[]) => void;
}

/**
 * Builds a fake Drizzle-shaped db that responds to two select() chains:
 *  1. lead lookup:    .select(...).from(agentRuns).where(...).limit(1)
 *  2. teammate query: .select(...).from(agentRuns).innerJoin(...).where(...).orderBy(...)
 *
 * The lead lookup is detected by the presence of `.limit()` directly off
 * `.where()` (no innerJoin in the chain). The teammate lookup chains
 * `.innerJoin()` before `.where().orderBy()`.
 */
function makeDb(scenario: DbScenario = {}) {
  const leadRows = scenario.leadRows ?? [];
  const teammateRows = scenario.teammateRows ?? [];
  const onSelect = scenario.onSelect;

  return {
    select: vi.fn((...args: unknown[]) => {
      if (onSelect) onSelect(...args);
      return {
        from: vi.fn(() => {
          // Branch 1: lead lookup (no innerJoin, ends in .limit())
          const leadChain = {
            where: vi.fn(() => ({
              limit: vi.fn(async () => leadRows),
            })),
            // Branch 2: teammate lookup (innerJoin → where → orderBy)
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                orderBy: vi.fn(async () => teammateRows),
              })),
            })),
          };
          return leadChain;
        }),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_ID = 'team-1';
const KEY = `team:state:${TEAM_ID}`;

const FIXED_NOW = new Date('2026-05-02T10:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

function makeStateFixture(): TeamState {
  return {
    leadStatus: 'running',
    leadAgentId: 'lead-agent-1',
    leadLastActiveAt: '2026-05-02T09:59:00.000Z',
    teammates: [
      {
        agentId: 'tm-1',
        memberId: 'mem-1',
        agentDefName: 'content-writer',
        parentAgentId: 'lead-agent-1',
        status: 'running',
        lastActiveAt: '2026-05-02T09:58:00.000Z',
        sleepUntil: null,
        displayName: 'Alex',
      },
    ],
    lastUpdatedAt: '2026-05-02T09:59:30.000Z',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('teamStateKey', () => {
  it('builds the canonical Redis key', () => {
    expect(teamStateKey('abc')).toBe('team:state:abc');
  });
});

describe('getTeamState — cache hit', () => {
  it('returns the cached value without touching the DB', async () => {
    const fixture = makeStateFixture();
    const redis = makeRedis({ [KEY]: JSON.stringify(fixture) });
    const onSelect = vi.fn();
    const db = makeDb({ onSelect });

    const result = await getTeamState(TEAM_ID, db as never, redis as never);

    expect(result).toEqual(fixture);
    expect(redis.get).toHaveBeenCalledWith(KEY);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('getTeamState — cache miss', () => {
  it('queries DB, populates Redis with TTL, and returns the freshly-built shape', async () => {
    const redis = makeRedis(); // empty
    const leadActiveAt = new Date('2026-05-02T09:55:00.000Z');
    const tmActiveAt = new Date('2026-05-02T09:54:00.000Z');
    const sleepUntil = new Date('2026-05-02T10:30:00.000Z');
    const db = makeDb({
      leadRows: [
        { id: 'lead-1', status: 'running', lastActiveAt: leadActiveAt },
      ],
      teammateRows: [
        {
          agentId: 'tm-1',
          memberId: 'mem-1',
          agentDefName: 'content-writer',
          parentAgentId: 'lead-1',
          status: 'sleeping',
          lastActiveAt: tmActiveAt,
          sleepUntil,
          displayName: 'Alex',
        },
      ],
    });

    const result = await getTeamState(TEAM_ID, db as never, redis as never);

    expect(result.leadStatus).toBe('running');
    expect(result.leadAgentId).toBe('lead-1');
    expect(result.leadLastActiveAt).toBe(leadActiveAt.toISOString());
    expect(result.teammates).toHaveLength(1);
    expect(result.teammates[0]).toEqual({
      agentId: 'tm-1',
      memberId: 'mem-1',
      agentDefName: 'content-writer',
      parentAgentId: 'lead-1',
      status: 'sleeping',
      lastActiveAt: tmActiveAt.toISOString(),
      sleepUntil: sleepUntil.toISOString(),
      displayName: 'Alex',
    });
    expect(result.lastUpdatedAt).toBe(FIXED_NOW.toISOString());

    // Wrote to Redis with the configured TTL
    expect(redis.setex).toHaveBeenCalledOnce();
    const [setKey, setTtl, setVal] = redis.setex.mock.calls[0];
    expect(setKey).toBe(KEY);
    expect(setTtl).toBe(TEAM_STATE_TTL_SECONDS);
    expect(JSON.parse(setVal as string)).toEqual(result);
  });

  it('handles empty lead row + empty teammates', async () => {
    const redis = makeRedis();
    const db = makeDb({ leadRows: [], teammateRows: [] });

    const result = await getTeamState(TEAM_ID, db as never, redis as never);

    expect(result.leadStatus).toBeNull();
    expect(result.leadAgentId).toBeNull();
    expect(result.leadLastActiveAt).toBeNull();
    expect(result.teammates).toEqual([]);
    expect(redis.setex).toHaveBeenCalledOnce();
  });
});

describe('getTeamState — TTL expiry simulated', () => {
  it('re-fetches from DB when Redis returns null (key expired)', async () => {
    // Seed Redis with stale data, then "expire" it by clearing the store
    // before the call — equivalent to TTL-driven eviction.
    const fixture = makeStateFixture();
    const redis = makeRedis({ [KEY]: JSON.stringify(fixture) });
    redis.store.delete(KEY); // simulate TTL eviction

    const db = makeDb({
      leadRows: [
        { id: 'lead-fresh', status: 'sleeping', lastActiveAt: null },
      ],
      teammateRows: [],
    });

    const result = await getTeamState(TEAM_ID, db as never, redis as never);

    expect(result.leadAgentId).toBe('lead-fresh');
    expect(result.leadStatus).toBe('sleeping');
    // Re-populated cache
    expect(redis.setex).toHaveBeenCalledOnce();
  });
});

describe('invalidateTeamState', () => {
  it('removes the key from Redis', async () => {
    const fixture = makeStateFixture();
    const redis = makeRedis({ [KEY]: JSON.stringify(fixture) });

    await invalidateTeamState(TEAM_ID, redis as never);

    expect(redis.del).toHaveBeenCalledWith(KEY);
    expect(redis.store.has(KEY)).toBe(false);
  });

  it('does not throw if Redis is unreachable', async () => {
    const redis = makeFailingRedis();
    await expect(
      invalidateTeamState(TEAM_ID, redis as never),
    ).resolves.toBeUndefined();
  });
});

describe('writeTeamStateField — leadStatus patch', () => {
  it('GET → patch → SETEX merges leadStatus while preserving other fields', async () => {
    const fixture = makeStateFixture();
    const redis = makeRedis({ [KEY]: JSON.stringify(fixture) });

    await writeTeamStateField(
      TEAM_ID,
      { leadStatus: 'sleeping', leadLastActiveAt: '2026-05-02T10:00:00.000Z' },
      redis as never,
    );

    expect(redis.setex).toHaveBeenCalledOnce();
    const [, ttl, val] = redis.setex.mock.calls[0];
    expect(ttl).toBe(TEAM_STATE_TTL_SECONDS);
    const written = JSON.parse(val as string) as TeamState;
    expect(written.leadStatus).toBe('sleeping');
    expect(written.leadLastActiveAt).toBe('2026-05-02T10:00:00.000Z');
    // Untouched fields preserved
    expect(written.leadAgentId).toBe(fixture.leadAgentId);
    expect(written.teammates).toEqual(fixture.teammates);
    expect(written.lastUpdatedAt).toBe(FIXED_NOW.toISOString());
  });
});

describe('writeTeamStateField — teammateUpdate', () => {
  it('patches the matching teammate by agentId and leaves siblings alone', async () => {
    const fixture: TeamState = {
      ...makeStateFixture(),
      teammates: [
        {
          agentId: 'tm-1',
          memberId: 'mem-1',
          agentDefName: 'content-writer',
          parentAgentId: 'lead-agent-1',
          status: 'running',
          lastActiveAt: '2026-05-02T09:58:00.000Z',
          sleepUntil: null,
          displayName: 'Alex',
        },
        {
          agentId: 'tm-2',
          memberId: 'mem-2',
          agentDefName: 'reply-curator',
          parentAgentId: 'lead-agent-1',
          status: 'sleeping',
          lastActiveAt: '2026-05-02T09:30:00.000Z',
          sleepUntil: '2026-05-02T11:00:00.000Z',
          displayName: 'Riley',
        },
      ],
    };
    const redis = makeRedis({ [KEY]: JSON.stringify(fixture) });

    await writeTeamStateField(
      TEAM_ID,
      {
        teammateUpdate: {
          agentId: 'tm-1',
          status: 'sleeping',
          sleepUntil: '2026-05-02T10:30:00.000Z',
        },
      },
      redis as never,
    );

    const written = JSON.parse(redis.setex.mock.calls[0][2] as string) as TeamState;
    expect(written.teammates).toHaveLength(2);
    const tm1 = written.teammates.find((t) => t.agentId === 'tm-1')!;
    expect(tm1.status).toBe('sleeping');
    expect(tm1.sleepUntil).toBe('2026-05-02T10:30:00.000Z');
    expect(tm1.displayName).toBe('Alex'); // preserved
    const tm2 = written.teammates.find((t) => t.agentId === 'tm-2')!;
    expect(tm2).toEqual(fixture.teammates[1]);
  });
});

describe('writeTeamStateField — teammateRemove', () => {
  it('drops the matching teammate from the array', async () => {
    const fixture: TeamState = {
      ...makeStateFixture(),
      teammates: [
        {
          agentId: 'tm-1',
          memberId: 'mem-1',
          agentDefName: 'content-writer',
          parentAgentId: 'lead-agent-1',
          status: 'running',
          lastActiveAt: '2026-05-02T09:58:00.000Z',
          sleepUntil: null,
          displayName: 'Alex',
        },
        {
          agentId: 'tm-2',
          memberId: 'mem-2',
          agentDefName: 'reply-curator',
          parentAgentId: 'lead-agent-1',
          status: 'running',
          lastActiveAt: '2026-05-02T09:55:00.000Z',
          sleepUntil: null,
          displayName: 'Riley',
        },
      ],
    };
    const redis = makeRedis({ [KEY]: JSON.stringify(fixture) });

    await writeTeamStateField(
      TEAM_ID,
      { teammateRemove: 'tm-1' },
      redis as never,
    );

    const written = JSON.parse(redis.setex.mock.calls[0][2] as string) as TeamState;
    expect(written.teammates).toHaveLength(1);
    expect(written.teammates[0].agentId).toBe('tm-2');
  });
});

describe('writeTeamStateField — teammateAdd', () => {
  it('appends a new teammate to the array', async () => {
    const fixture = makeStateFixture();
    const redis = makeRedis({ [KEY]: JSON.stringify(fixture) });

    const newTeammate: TeamState['teammates'][number] = {
      agentId: 'tm-new',
      memberId: 'mem-new',
      agentDefName: 'engagement-scout',
      parentAgentId: 'lead-agent-1',
      status: 'queued',
      lastActiveAt: '2026-05-02T10:00:00.000Z',
      sleepUntil: null,
      displayName: 'Sam',
    };

    await writeTeamStateField(
      TEAM_ID,
      { teammateAdd: newTeammate },
      redis as never,
    );

    const written = JSON.parse(redis.setex.mock.calls[0][2] as string) as TeamState;
    expect(written.teammates).toHaveLength(2);
    expect(written.teammates[1]).toEqual(newTeammate);
  });
});

describe('writeTeamStateField — Redis miss', () => {
  it('falls back gracefully when the key is absent (no SETEX, no throw)', async () => {
    const redis = makeRedis(); // empty — GET returns null

    await expect(
      writeTeamStateField(
        TEAM_ID,
        { leadStatus: 'running' },
        redis as never,
      ),
    ).resolves.toBeUndefined();

    // Cache miss on write-through is a no-op: next read repopulates from DB.
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('does not throw when Redis itself errors', async () => {
    const redis = makeFailingRedis();

    await expect(
      writeTeamStateField(
        TEAM_ID,
        { leadStatus: 'running' },
        redis as never,
      ),
    ).resolves.toBeUndefined();
  });
});
