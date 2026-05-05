import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { TeamState } from '@/lib/team/team-state-cache';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

// UI-D Task 3: the route now reads activeRun from `getTeamState` instead
// of issuing a direct agent_runs SELECT. We only need to mock two select
// chains here (team lookup + members) and stub getTeamState for the lead
// state.

type TeamRow = {
  id: string;
  userId: string;
  name: string;
  createdAt: Date;
};
type MemberRow = {
  id: string;
  agent_type: string;
  display_name: string;
  status: string;
  last_active_at: Date | null;
};

let teamRows: TeamRow[] = [];
let memberRows: MemberRow[] = [];

vi.mock('@/lib/db', () => ({
  db: {
    select: (projection: Record<string, unknown>) => {
      const fields = Object.keys(projection);
      const isTeam = fields.includes('userId') && fields.includes('name');
      const isMembers = fields.includes('agent_type');

      if (isTeam) {
        return {
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve(teamRows),
            }),
          }),
        };
      }

      if (isMembers) {
        return {
          from: () => ({
            where: () => Promise.resolve(memberRows),
          }),
        };
      }

      // Fallback — should not be hit
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      };
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
    inArray: () => ({}),
  };
});

let teamStateMock: TeamState = {
  leadStatus: null,
  leadAgentId: null,
  leadLastActiveAt: null,
  teammates: [],
  lastUpdatedAt: '2026-05-02T00:00:00.000Z',
};

const getTeamStateMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/team/team-state-cache', () => ({
  getTeamState: getTeamStateMock,
}));

const sentinelRedis = { __sentinel: 'kv-client' } as const;
vi.mock('@/lib/redis', () => ({
  getKeyValueClient: vi.fn(() => sentinelRedis),
}));

import { GET } from '../route';

beforeEach(() => {
  authUserId = 'user-1';
  teamRows = [
    {
      id: 'team-1',
      userId: 'user-1',
      name: 'Test Team',
      createdAt: new Date('2026-05-02T00:00:00Z'),
    },
  ];
  memberRows = [];
  teamStateMock = {
    leadStatus: null,
    leadAgentId: null,
    leadLastActiveAt: null,
    teammates: [],
    lastUpdatedAt: '2026-05-02T00:00:00.000Z',
  };
  getTeamStateMock.mockReset();
  getTeamStateMock.mockImplementation(async () => teamStateMock);
});

function makeReq(teamId: string): NextRequest {
  return new NextRequest(`http://test/api/team/status?teamId=${teamId}`);
}

describe('GET /api/team/status', () => {
  it('returns activeRun when team-state cache reports lead as running', async () => {
    teamStateMock = {
      leadStatus: 'running',
      leadAgentId: 'lead-agent-1',
      leadLastActiveAt: '2026-05-02T01:23:45.000Z',
      teammates: [],
      lastUpdatedAt: '2026-05-02T01:23:45.000Z',
    };
    const res = await GET(makeReq('team-1'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.activeRun).toMatchObject({
      runId: 'lead-agent-1',
      status: 'running',
      lastActiveAt: '2026-05-02T01:23:45.000Z',
    });
  });

  it('returns activeRun when team-state cache reports lead as resuming', async () => {
    teamStateMock = {
      leadStatus: 'resuming',
      leadAgentId: 'lead-agent-2',
      leadLastActiveAt: '2026-05-02T02:00:00.000Z',
      teammates: [],
      lastUpdatedAt: '2026-05-02T02:00:00.000Z',
    };
    const res = await GET(makeReq('team-1'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.activeRun).toMatchObject({
      runId: 'lead-agent-2',
      status: 'resuming',
    });
  });

  it('returns activeRun=null when lead is sleeping', async () => {
    teamStateMock = {
      leadStatus: 'sleeping',
      leadAgentId: 'lead-agent-3',
      leadLastActiveAt: '2026-05-02T03:00:00.000Z',
      teammates: [],
      lastUpdatedAt: '2026-05-02T03:00:00.000Z',
    };
    const res = await GET(makeReq('team-1'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.activeRun).toBeNull();
  });

  it('returns activeRun=null when lead has never run (cache reports leadStatus=null)', async () => {
    // teamStateMock default — leadStatus null
    const res = await GET(makeReq('team-1'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.activeRun).toBeNull();
  });

  it('passes the configured KV redis client to getTeamState', async () => {
    teamStateMock = {
      leadStatus: 'running',
      leadAgentId: 'lead-agent-1',
      leadLastActiveAt: '2026-05-02T01:23:45.000Z',
      teammates: [],
      lastUpdatedAt: '2026-05-02T01:23:45.000Z',
    };
    await GET(makeReq('team-1'));
    expect(getTeamStateMock).toHaveBeenCalledWith(
      'team-1',
      expect.anything(),
      sentinelRedis,
    );
  });
});
