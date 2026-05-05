// Task 7 — endpoint contract test for GET /api/team/conversations/[id]/messages.
//
// Verifies the redactor is wired into the GET handler so that raw
// tool_input / tool_output / vendor-bound tool names / agent type names
// never reach the client. Mocks `@/lib/auth` and `@/lib/db` so the test
// runs without Postgres.
//
// The DB mock supports two distinct query shapes used by the GET handler:
//   1. conversation ownership: select().from().innerJoin().where().limit()
//   2. messages list:           select().from().where().orderBy()

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

interface ConvRow {
  id: string;
  teamId: string;
  ownerUserId: string;
  title: string | null;
  updatedAt: Date;
}

interface MessageRow {
  id: string;
  runId: string | null;
  fromMemberId: string | null;
  toMemberId: string | null;
  type: string;
  content: string | null;
  contentBlocks: unknown;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

let convRows: ConvRow[] = [];
let messageRows: MessageRow[] = [];

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        // conv ownership query path: from().innerJoin().where().limit()
        innerJoin: () => ({
          where: () => ({
            limit: () => Promise.resolve(convRows),
          }),
        }),
        // messages SELECT path: from().where().orderBy()
        where: () => ({
          orderBy: () => Promise.resolve(messageRows),
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
    asc: () => ({}),
  };
});

import { GET } from '../messages/route';

beforeEach(() => {
  authUserId = 'user-1';
  convRows = [
    {
      id: 'conv-1',
      teamId: 'team-1',
      ownerUserId: 'user-1',
      title: 'My conversation',
      updatedAt: new Date('2026-05-04T00:00:00Z'),
    },
  ];
  messageRows = [];
});

function makeReq(): NextRequest {
  return new NextRequest(
    'http://test/api/team/conversations/conv-1/messages',
  );
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('GET /api/team/conversations/[id]/messages — redaction', () => {
  it('rejects unauthenticated requests with 401', async () => {
    authUserId = null;
    const res = await GET(makeReq(), makeParams('conv-1'));
    expect(res.status).toBe(401);
  });

  it('returns 404 when the conversation does not exist', async () => {
    convRows = [];
    const res = await GET(makeReq(), makeParams('conv-1'));
    expect(res.status).toBe(404);
  });

  it('returns 404 when the conversation belongs to another user', async () => {
    convRows = [
      {
        id: 'conv-1',
        teamId: 'team-1',
        ownerUserId: 'someone-else',
        title: null,
        updatedAt: new Date('2026-05-04T00:00:00Z'),
      },
    ];
    const res = await GET(makeReq(), makeParams('conv-1'));
    expect(res.status).toBe(404);
  });

  it('redacts leaky metadata before returning to the client', async () => {
    messageRows = [
      {
        id: 'msg-1',
        runId: 'run-1',
        fromMemberId: null,
        toMemberId: null,
        type: 'tool_use',
        content: null,
        contentBlocks: [
          {
            type: 'tool_use',
            id: 'tu-1',
            name: 'find_threads_via_xai',
            input: { query: 'secret query content', limit: 50 },
          },
        ],
        metadata: {
          tool_use_id: 'tu-1',
          tool_name: 'find_threads_via_xai',
          tool_input: {
            query: 'secret query content',
            description: 'Surface promising threads',
          },
          tool_output: 'raw xai response payload not for client eyes',
          agent_name: 'social-media-manager',
        },
        createdAt: new Date('2026-05-04T01:00:00Z'),
      },
    ];

    const res = await GET(makeReq(), makeParams('conv-1'));
    expect(res.status).toBe(200);

    const body = await res.json();
    const serialized = JSON.stringify(body);

    // Banned strings — these would leak the multi-agent architecture and
    // AI vendor binding to any logged-in user.
    expect(serialized).not.toContain('xai');
    expect(serialized).not.toContain('find_threads_via_xai');
    expect(serialized).not.toContain('secret query content');
    expect(serialized).not.toContain('social-media-manager');
    expect(serialized).not.toContain('tool_output');

    // Semantic label substitutions surface in the payload.
    expect(body.messages).toHaveLength(1);
    const m = body.messages[0];
    expect(m.metadata.tool_name).toBe('searching');
    expect(m.metadata.agent_name).toBe('Content Specialist');

    // tool_input is sanitized: only `description` should remain (capped).
    expect(m.metadata.tool_input).toEqual({
      description: 'Surface promising threads',
    });

    // tool_use block in contentBlocks is redacted to the public label.
    expect(m.contentBlocks[0].name).toBe('searching');
    expect(m.contentBlocks[0].input).toEqual({});

    // Shape preserved: createdAt is a string, not a Date.
    expect(typeof m.createdAt).toBe('string');
  });

  it('passes through clean rows without altering the response shape', async () => {
    messageRows = [
      {
        id: 'msg-2',
        runId: null,
        fromMemberId: null,
        toMemberId: null,
        type: 'user_prompt',
        content: 'hello team',
        contentBlocks: [{ type: 'text', text: 'hello team' }],
        metadata: { trigger: 'conversation_message' },
        createdAt: new Date('2026-05-04T02:00:00Z'),
      },
    ];

    const res = await GET(makeReq(), makeParams('conv-1'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.conversationId).toBe('conv-1');
    expect(body.title).toBe('My conversation');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].id).toBe('msg-2');
    expect(body.messages[0].content).toBe('hello team');
    expect(body.messages[0].metadata).toEqual({
      trigger: 'conversation_message',
    });
    expect(body.messages[0].contentBlocks).toEqual([
      { type: 'text', text: 'hello team' },
    ]);
  });
});
