import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

// Three select chains fan out from GET (in implementation order):
//   (1) team lookup           — fields include `userId` + `name`
//   (2) team_members list     — fields include `agent_type`
//   (3) active lead lookup    — fields include `runId` + `status` (from
//                                agent_runs WHERE agentDefName='coordinator'
//                                AND status IN ('running','resuming'))
// The mock dispatches on field presence so the route-level call order
// doesn't couple the test to the implementation's internal sequence.

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
type ActiveLeadRow = {
  runId: string;
  status: string;
  lastActiveAt: Date;
};

let teamRows: TeamRow[] = [];
let memberRows: MemberRow[] = [];
let activeLeadRows: ActiveLeadRow[] = [];

vi.mock('@/lib/db', () => ({
  db: {
    select: (projection: Record<string, unknown>) => {
      const fields = Object.keys(projection);
      const isTeam = fields.includes('userId') && fields.includes('name');
      const isMembers = fields.includes('agent_type');
      const isActiveLead =
        fields.includes('runId') && fields.includes('status');

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

      if (isActiveLead) {
        return {
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve(activeLeadRows),
            }),
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
  activeLeadRows = [];
});

function makeReq(teamId: string): NextRequest {
  return new NextRequest(`http://test/api/team/status?teamId=${teamId}`);
}

describe('GET /api/team/status', () => {
  it('returns activeRun when lead agent_runs status is running', async () => {
    activeLeadRows = [
      {
        runId: 'lead-agent-1',
        status: 'running',
        lastActiveAt: new Date('2026-05-02T01:23:45Z'),
      },
    ];
    const res = await GET(makeReq('team-1'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.activeRun).toMatchObject({
      runId: 'lead-agent-1',
      status: 'running',
    });
  });

  it('returns activeRun=null when lead is sleeping (no active row)', async () => {
    activeLeadRows = [];
    const res = await GET(makeReq('team-1'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.activeRun).toBeNull();
  });
});
