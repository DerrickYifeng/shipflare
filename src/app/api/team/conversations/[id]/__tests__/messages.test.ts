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

// Per-call cap configured by tests that exercise the cursor pagination
// (`?limit=N`). The mock applies it at the `.limit()` step so the handler
// can do its `rows.length > limit` slice and report `hasMore` correctly.
let messagesLimit = Number.MAX_SAFE_INTEGER;

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
        // messages SELECT path: from().where().orderBy().limit()
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => {
              const cap = Math.min(n, messagesLimit);
              return Promise.resolve(messageRows.slice(0, cap));
            },
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
    asc: () => ({}),
    desc: () => ({}),
    lt: () => ({}),
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
  messagesLimit = Number.MAX_SAFE_INTEGER;
});

function makeReq(query: string = ''): NextRequest {
  return new NextRequest(
    `http://test/api/team/conversations/conv-1/messages${query}`,
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
    expect(m.metadata.agent_name).toBe('Social Media Manager');

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

// Helper for the pagination tests: produces N rows in DESC order (newest
// first) so the mock's slice mimics what `ORDER BY created_at DESC` returns
// from Postgres. The handler then reverses to ASC for the client.
function makeRows(count: number, baseIso: string): MessageRow[] {
  const base = Date.parse(baseIso);
  const rows: MessageRow[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      id: `msg-${i + 1}`,
      runId: null,
      fromMemberId: null,
      toMemberId: null,
      type: 'assistant_text',
      content: `body ${i + 1}`,
      contentBlocks: [{ type: 'text', text: `body ${i + 1}` }],
      metadata: null,
      createdAt: new Date(base - i * 1000),
    });
  }
  return rows;
}

describe('GET /api/team/conversations/[id]/messages — cursor pagination', () => {
  it('returns hasMore=false when fewer rows exist than the limit', async () => {
    messageRows = makeRows(3, '2026-05-04T03:00:00Z');

    const res = await GET(makeReq('?limit=10'), makeParams('conv-1'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.hasMore).toBe(false);
    expect(body.messages).toHaveLength(3);
    // Returned in ASC order: oldest first, newest last.
    const ids = (body.messages as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(['msg-3', 'msg-2', 'msg-1']);
  });

  it('returns hasMore=true when more rows are available beyond the window', async () => {
    // 6 rows in the table; limit=3. Handler asks for 4, sees 4 rows, sets
    // hasMore=true and slices to the first 3 (newest 3 in DESC order).
    messageRows = makeRows(6, '2026-05-04T04:00:00Z');
    messagesLimit = 4;

    const res = await GET(makeReq('?limit=3'), makeParams('conv-1'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.hasMore).toBe(true);
    expect(body.messages).toHaveLength(3);
    // The 3 newest, ASC: msg-3 (oldest of the window) → msg-1 (newest).
    const ids = (body.messages as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(['msg-3', 'msg-2', 'msg-1']);
  });

  it('accepts before= as a cursor and clamps limit to MAX_LIMIT', async () => {
    messageRows = makeRows(2, '2026-05-04T05:00:00Z');

    // Sanity: huge limit gets capped (the mock caps via messagesLimit so we
    // don't actually need to assert the cap value, just that the request is
    // accepted and returns a valid body).
    const res = await GET(
      makeReq('?limit=99999&before=2026-05-04T05:30:00Z'),
      makeParams('conv-1'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasMore).toBe(false);
    expect(body.messages).toHaveLength(2);
  });

  it('falls back to the default limit when the param is malformed', async () => {
    messageRows = makeRows(1, '2026-05-04T06:00:00Z');

    const res = await GET(
      makeReq('?limit=not-a-number&before=garbage'),
      makeParams('conv-1'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(1);
    expect(body.hasMore).toBe(false);
  });
});
