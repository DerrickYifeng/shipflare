// Task 8 — endpoint contract test for GET /api/team/activity.
//
// Verifies the redactor is wired into the GET handler so that raw
// tool_input / tool_output / vendor-bound tool names / agent type names
// never reach the client. Mocks `@/lib/auth` and `@/lib/db` so the test
// runs without Postgres.
//
// The DB mock supports two distinct query shapes used by the GET handler:
//   1. member ownership: select().from().innerJoin().where().limit()
//   2. messages list:    select().from().where().orderBy().limit()

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

interface MemberRow {
  id: string;
  teamId: string;
  agentType: string;
  displayName: string;
  status: string;
  lastActiveAt: Date | null;
  ownerId: string;
}

interface MessageRow {
  id: string;
  runId: string | null;
  teamId: string;
  fromMemberId: string | null;
  toMemberId: string | null;
  type: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

let memberRows: MemberRow[] = [];
let messageRows: MessageRow[] = [];

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        // member ownership query path: from().innerJoin().where().limit()
        innerJoin: () => ({
          where: () => ({
            limit: () => Promise.resolve(memberRows),
          }),
        }),
        // messages SELECT path: from().where().orderBy().limit()
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(messageRows),
          }),
        }),
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
    eq: () => ({}),
    and: () => ({}),
    or: () => ({}),
    asc: () => ({}),
  };
});

import { GET } from '../activity/route';

beforeEach(() => {
  authUserId = 'user-1';
  // member.agentType is now redacted via `publicAgentLabel` in the
  // response envelope (Job 1 follow-up to Task 8), so the realistic raw
  // type ('social-media-manager') is safe to use here — the assertions
  // verify the response carries the founder-facing label instead.
  memberRows = [
    {
      id: 'member-1',
      teamId: 'team-1',
      agentType: 'social-media-manager',
      displayName: 'Member',
      status: 'idle',
      lastActiveAt: new Date('2026-05-04T00:00:00Z'),
      ownerId: 'user-1',
    },
  ];
  messageRows = [];
});

function makeReq(memberId?: string | null): NextRequest {
  const url = new URL('http://test/api/team/activity');
  if (memberId !== null) {
    url.searchParams.set('memberId', memberId ?? 'member-1');
  }
  return new NextRequest(url);
}

describe('GET /api/team/activity — redaction', () => {
  it('rejects unauthenticated requests with 401', async () => {
    authUserId = null;
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it('returns 400 when memberId query param is missing', async () => {
    const res = await GET(makeReq(null));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the member does not exist', async () => {
    memberRows = [];
    const res = await GET(makeReq());
    expect(res.status).toBe(404);
  });

  it('returns 404 when the member belongs to another user', async () => {
    memberRows = [
      {
        id: 'member-1',
        teamId: 'team-1',
        agentType: 'social-media-manager',
        displayName: 'Member',
        status: 'idle',
        lastActiveAt: null,
        ownerId: 'someone-else',
      },
    ];
    const res = await GET(makeReq());
    expect(res.status).toBe(404);
  });

  it('redacts leaky metadata before returning to the client', async () => {
    messageRows = [
      {
        id: 'msg-1',
        runId: 'run-1',
        teamId: 'team-1',
        fromMemberId: 'member-1',
        toMemberId: null,
        type: 'tool_use',
        content: null,
        metadata: {
          tool_use_id: 'tu-1',
          tool_name: 'Task',
          tool_input: {
            subagent_type: 'social-media-manager',
            description: 'fill reply slot',
            prompt:
              'Mode: discover-and-fill-slot\nplanItemId: plan-123\nfind a thread and reply',
          },
          tool_output: 'raw subagent transcript not for client eyes',
          agent_name: 'coordinator',
        },
        createdAt: new Date('2026-05-04T01:00:00Z'),
      },
    ];

    const res = await GET(makeReq());
    expect(res.status).toBe(200);

    const body = await res.json();
    const serialized = JSON.stringify(body);

    // Banned strings — these would leak the multi-agent architecture and
    // internal mode flags to any logged-in user. With the Job 1 follow-up
    // patch, member.agentType is now redacted too, so the realistic
    // 'social-media-manager' raw type must NOT appear anywhere in the body.
    expect(serialized).not.toContain('social-media-manager');
    expect(serialized).not.toContain('discover-and-fill-slot');
    expect(serialized).not.toContain('coordinator');
    expect(serialized).not.toContain('Mode:');
    expect(serialized).not.toContain('tool_output');
    expect(serialized).not.toContain('plan-123');

    // member envelope: raw agentType is replaced with the founder-facing label.
    expect(body.member.agentType).toBe('Content Specialist');

    // Semantic label substitutions surface in the payload.
    expect(body.messages).toHaveLength(1);
    const m = body.messages[0];
    expect(m.metadata.tool_name).toBe('delegating');
    expect(m.metadata.agent_name).toBe('Team Lead');

    // tool_input is sanitized: only `description` and friendly subagent_type remain.
    expect(m.metadata.tool_input).toEqual({
      subagent_type: 'Content Specialist',
      description: 'fill reply slot',
    });

    // Shape preserved: `from`/`to` rename and createdAt as ISO string.
    expect(m.from).toBe('member-1');
    expect(m.to).toBeNull();
    expect(typeof m.createdAt).toBe('string');
    expect(m.createdAt).toBe('2026-05-04T01:00:00.000Z');
  });

  it('passes through clean rows without altering the response shape', async () => {
    messageRows = [
      {
        id: 'msg-2',
        runId: null,
        teamId: 'team-1',
        fromMemberId: null,
        toMemberId: 'member-1',
        type: 'user_prompt',
        content: 'hello team',
        metadata: { trigger: 'conversation_message' },
        createdAt: new Date('2026-05-04T02:00:00Z'),
      },
    ];

    const res = await GET(makeReq());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.member.id).toBe('member-1');
    expect(body.member.teamId).toBe('team-1');
    expect(body.messages).toHaveLength(1);
    const m = body.messages[0];
    expect(m.id).toBe('msg-2');
    expect(m.content).toBe('hello team');
    expect(m.from).toBeNull();
    expect(m.to).toBe('member-1');
    expect(m.metadata).toEqual({ trigger: 'conversation_message' });
  });
});
