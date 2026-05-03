// UI-B Task 8 — endpoint contract test for /api/team/[teamId]/teammates.
//
// Mocks the team-state cache + DB lookups so the test verifies the
// route's shaping behavior (auth, ownership check, lead/teammate split)
// without booting Postgres or Redis.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { TeamState } from '@/lib/team/team-state-cache';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

type TeamRow = { id: string; userId: string };
type LeadMemberRow = { id: string; displayName: string };

let teamRows: TeamRow[] = [];
let leadMemberRows: LeadMemberRow[] = [];

vi.mock('@/lib/db', () => ({
  db: {
    select: (projection: Record<string, unknown>) => {
      const fields = Object.keys(projection);
      const isTeam = fields.includes('id') && fields.includes('userId');
      const isLeadMember =
        fields.includes('id') && fields.includes('displayName');

      if (isTeam) {
        return {
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve(teamRows),
            }),
          }),
        };
      }
      if (isLeadMember) {
        return {
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve(leadMemberRows),
            }),
          }),
        };
      }
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
  teamRows = [{ id: 'team-1', userId: 'user-1' }];
  leadMemberRows = [{ id: 'member-lead', displayName: 'Team Lead' }];
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

function makeReq(): NextRequest {
  return new NextRequest('http://test/api/team/team-1/teammates');
}

function makeParams(teamId: string) {
  return { params: Promise.resolve({ teamId }) };
}

describe('GET /api/team/[teamId]/teammates', () => {
  it('rejects unauthenticated requests with 401', async () => {
    authUserId = null;
    const res = await GET(makeReq(), makeParams('team-1'));
    expect(res.status).toBe(401);
  });

  it('returns 404 when the team does not exist', async () => {
    teamRows = [];
    const res = await GET(makeReq(), makeParams('team-1'));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the team belongs to another user (no existence leak)", async () => {
    teamRows = [{ id: 'team-1', userId: 'someone-else' }];
    const res = await GET(makeReq(), makeParams('team-1'));
    expect(res.status).toBe(404);
  });

  it('returns lead + empty teammates list when the lead has never run', async () => {
    const res = await GET(makeReq(), makeParams('team-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lead).toMatchObject({
      memberId: 'member-lead',
      agentDefName: 'coordinator',
      displayName: 'Team Lead',
      status: null,
      agentId: null,
      lastActiveAt: null,
    });
    expect(body.teammates).toEqual([]);
  });

  it('hydrates lead status from the team-state cache', async () => {
    teamStateMock = {
      leadStatus: 'running',
      leadAgentId: 'lead-agent-1',
      leadLastActiveAt: '2026-05-02T01:23:45.000Z',
      teammates: [],
      lastUpdatedAt: '2026-05-02T01:23:45.000Z',
    };
    const res = await GET(makeReq(), makeParams('team-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lead).toMatchObject({
      agentId: 'lead-agent-1',
      status: 'running',
      lastActiveAt: '2026-05-02T01:23:45.000Z',
    });
  });

  it('returns the cached non-terminal teammate list verbatim', async () => {
    teamStateMock = {
      leadStatus: 'sleeping',
      leadAgentId: 'lead-agent-1',
      leadLastActiveAt: '2026-05-02T01:00:00.000Z',
      teammates: [
        {
          agentId: 'agent-2',
          memberId: 'member-author',
          agentDefName: 'content-manager',
          parentAgentId: 'lead-agent-1',
          status: 'running',
          lastActiveAt: '2026-05-02T01:23:45.000Z',
          sleepUntil: null,
          displayName: 'Author',
        },
        {
          agentId: 'agent-3',
          memberId: 'member-researcher',
          agentDefName: 'researcher',
          parentAgentId: 'lead-agent-1',
          status: 'sleeping',
          lastActiveAt: '2026-05-02T01:24:00.000Z',
          sleepUntil: '2026-05-02T01:30:00.000Z',
          displayName: 'Researcher',
        },
      ],
      lastUpdatedAt: '2026-05-02T01:24:00.000Z',
    };
    const res = await GET(makeReq(), makeParams('team-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.teammates).toHaveLength(2);
    expect(body.teammates[0]).toMatchObject({
      agentId: 'agent-2',
      status: 'running',
      displayName: 'Author',
    });
    expect(body.teammates[1]).toMatchObject({
      agentId: 'agent-3',
      status: 'sleeping',
      sleepUntil: '2026-05-02T01:30:00.000Z',
    });
  });

  it('returns lead=null when the team has no coordinator team_members row', async () => {
    leadMemberRows = [];
    const res = await GET(makeReq(), makeParams('team-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lead).toBeNull();
  });

  it('passes the configured KV redis client to getTeamState', async () => {
    await GET(makeReq(), makeParams('team-1'));
    expect(getTeamStateMock).toHaveBeenCalledWith(
      'team-1',
      expect.anything(),
      sentinelRedis,
    );
  });
});
