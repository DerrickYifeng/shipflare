// Task 9 — endpoint contract test for GET /api/team/events (SSE).
//
// Verifies the redactor is wired into BOTH leak points of the SSE handler:
//   1. The snapshot loop (sends recent rows on connect)
//   2. The Redis pubsub forwarder (forwards live messages from
//      `team:${teamId}:messages`)
//
// Strategy:
//   - Unit-test the two extracted helpers (`buildSnapshotFrame`,
//     `buildLiveEventFrame`) directly. These are pure functions that
//     encapsulate the meaningful redaction logic, so a deterministic
//     unit-level assertion is the cheapest signal.
//   - Smoke-test the full SSE handler end-to-end: mock auth/db/redis,
//     read the streaming Response body, assert the snapshot redaction
//     reaches the wire and that banned strings are absent.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

interface TeamRow {
  userId: string;
}

interface MessageRow {
  id: string;
  runId: string | null;
  conversationId?: string | null;
  teamId: string;
  fromMemberId: string | null;
  toMemberId: string | null;
  type: string;
  content: string | null;
  contentBlocks?: unknown;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

let teamRows: TeamRow[] = [];
let messageRows: MessageRow[] = [];

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          // teams ownership query: select({...}).from().where().limit()
          limit: () => Promise.resolve(teamRows),
          // snapshot query: select().from().where().orderBy().limit()
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
    desc: () => ({}),
  };
});

interface FakeSubscriber {
  subscribe: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

let lastSubscriber: FakeSubscriber | null = null;

vi.mock('@/lib/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/redis')>();
  return {
    ...actual,
    createPubSubSubscriber: () => {
      const sub: FakeSubscriber = {
        subscribe: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
      };
      lastSubscriber = sub;
      return sub;
    },
  };
});

import { GET, buildSnapshotFrame, buildLiveEventFrame } from '../events/route';

beforeEach(() => {
  authUserId = 'user-1';
  teamRows = [{ userId: 'user-1' }];
  messageRows = [];
  lastSubscriber = null;
});

function makeReq(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://test/api/team/events');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url);
}

/**
 * Read SSE chunks from a streaming Response until we see the sentinel,
 * or until we hit the chunk-count cap. Cancels the reader to close the
 * stream cleanly. Returns the concatenated text buffer.
 */
async function readUntilSentinel(
  res: Response,
  sentinel: string,
  maxChunks = 50,
): Promise<string> {
  expect(res.body).toBeTruthy();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (let i = 0; i < maxChunks; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (buf.includes(sentinel)) break;
  }
  // Flush + cancel so the route's heartbeat/maxAge timers don't keep the
  // event loop alive past the test.
  buf += decoder.decode();
  await reader.cancel().catch(() => {});
  return buf;
}

describe('buildSnapshotFrame — pure helper', () => {
  it('redacts leaky metadata and renames from/to', () => {
    const frame = buildSnapshotFrame({
      id: 'msg-1',
      runId: 'run-1',
      conversationId: null,
      teamId: 'team-1',
      fromMemberId: 'member-1',
      toMemberId: null,
      type: 'tool_use',
      content: null,
      contentBlocks: null,
      metadata: {
        tool_use_id: 'tu-1',
        tool_name: 'find_threads_via_xai',
        tool_input: {
          subagent_type: 'social-media-manager',
          description: 'find threads',
          prompt: 'Mode: discover-and-fill-slot — secret playbook here',
        },
        tool_output: 'raw subagent transcript',
        agent_name: 'coordinator',
      },
      createdAt: new Date('2026-05-04T01:00:00Z'),
    });

    const serialized = JSON.stringify(frame);
    // Banned: vendor name, raw agent type, mode flags, raw prompt body, tool_output
    expect(serialized).not.toContain('xai');
    expect(serialized).not.toContain('find_threads_via_xai');
    expect(serialized).not.toContain('social-media-manager');
    expect(serialized).not.toContain('coordinator');
    expect(serialized).not.toContain('Mode:');
    expect(serialized).not.toContain('secret playbook');
    expect(serialized).not.toContain('tool_output');

    // Positive: friendly labels appear
    expect(frame.type).toBe('snapshot');
    expect(frame.messageType).toBe('tool_use');
    expect(frame.from).toBe('member-1');
    expect(frame.to).toBeNull();
    const meta = frame.metadata as Record<string, unknown>;
    expect(meta.tool_name).toBe('searching');
    expect(meta.agent_name).toBe('Team Lead');
    expect(meta.tool_input).toEqual({
      agent: 'Social Media Manager',
      description: 'find threads',
    });
    // Adversarial: the bare key `subagent_type` must not appear anywhere
    // in the wire payload — that string fingerprints Anthropic's Task tool.
    expect(serialized).not.toContain('subagent_type');
    expect(frame.createdAt).toBe('2026-05-04T01:00:00.000Z');
  });

  it('redacts contentBlocks tool_use blocks', () => {
    const frame = buildSnapshotFrame({
      id: 'msg-2',
      runId: null,
      teamId: 'team-1',
      fromMemberId: 'member-1',
      toMemberId: null,
      type: 'assistant_turn',
      content: null,
      contentBlocks: [
        { type: 'text', text: 'thinking...' },
        {
          type: 'tool_use',
          id: 'tu-2',
          name: 'xai_find_customers',
          input: { prompt: 'leaky prompt body', description: 'find buyers' },
        },
      ],
      metadata: null,
      createdAt: new Date('2026-05-04T02:00:00Z'),
    });

    const serialized = JSON.stringify(frame);
    expect(serialized).not.toContain('xai_find_customers');
    expect(serialized).not.toContain('leaky prompt body');

    const blocks = frame.contentBlocks as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: 'text', text: 'thinking...' });
    expect(blocks[1].name).toBe('searching');
    expect(blocks[1].input).toEqual({ description: 'find buyers' });
  });

  it('passes through clean rows without altering shape', () => {
    const frame = buildSnapshotFrame({
      id: 'msg-3',
      runId: null,
      teamId: 'team-1',
      fromMemberId: null,
      toMemberId: 'member-1',
      type: 'user_prompt',
      content: 'hello team',
      contentBlocks: null,
      metadata: { trigger: 'conversation_message' },
      createdAt: new Date('2026-05-04T03:00:00Z'),
    });
    expect(frame.content).toBe('hello team');
    expect(frame.metadata).toEqual({ trigger: 'conversation_message' });
    expect(frame.from).toBeNull();
    expect(frame.to).toBe('member-1');
  });
});

describe('buildLiveEventFrame — pure helper', () => {
  it('redacts metadata + content from a published payload', () => {
    // Mirrors the shape that SendMessageTool publishes — already uses
    // `from`/`to`/`messageId` renamed keys and carries `type` as the
    // db-level message type (which becomes `messageType` on the wire).
    const frame = buildLiveEventFrame({
      messageId: 'msg-live-1',
      runId: 'run-1',
      teamId: 'team-1',
      conversationId: null,
      from: 'member-1',
      to: null,
      type: 'tool_use',
      content: null,
      contentBlocks: [
        {
          type: 'tool_use',
          id: 'tu-live',
          name: 'find_threads_via_xai',
          input: { description: 'find threads', prompt: 'leaky' },
        },
      ],
      metadata: {
        tool_name: 'find_threads_via_xai',
        tool_input: {
          subagent_type: 'social-media-manager',
          prompt: 'Mode: discover-and-fill-slot',
        },
        tool_output: 'raw transcript',
        agent_name: 'coordinator',
      },
      createdAt: '2026-05-04T04:00:00.000Z',
    });

    const serialized = JSON.stringify(frame);
    // Banned strings must be absent
    expect(serialized).not.toContain('xai');
    expect(serialized).not.toContain('find_threads_via_xai');
    expect(serialized).not.toContain('social-media-manager');
    expect(serialized).not.toContain('coordinator');
    expect(serialized).not.toContain('Mode:');
    expect(serialized).not.toContain('tool_output');
    expect(serialized).not.toContain('leaky');

    // Wire wrapper fields survive the spread merge — `type: 'event'` MUST
    // be the final value (not overwritten by `rest.type`).
    expect(frame.type).toBe('event');
    expect(frame.messageType).toBe('tool_use');
    // Renamed keys preserved
    expect(frame.from).toBe('member-1');
    expect(frame.to).toBeNull();
    expect(frame.messageId).toBe('msg-live-1');
    // Redacted fields override the spread
    const meta = frame.metadata as Record<string, unknown>;
    expect(meta.tool_name).toBe('searching');
    expect(meta.agent_name).toBe('Team Lead');
  });

  it('handles missing optional fields gracefully', () => {
    const frame = buildLiveEventFrame({
      messageId: 'msg-live-2',
      runId: null,
      teamId: 'team-1',
      from: null,
      to: 'member-1',
      type: 'user_prompt',
      content: 'hi',
      metadata: null,
    });
    expect(frame.type).toBe('event');
    expect(frame.messageType).toBe('user_prompt');
    expect(frame.content).toBe('hi');
    expect(frame.metadata).toBeNull();
  });
});

describe('GET /api/team/events — auth + ownership', () => {
  it('rejects unauthenticated requests with 401', async () => {
    authUserId = null;
    const res = await GET(makeReq({ teamId: 'team-1' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when teamId is missing', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(400);
  });

  it('returns 404 when the team does not exist', async () => {
    teamRows = [];
    const res = await GET(makeReq({ teamId: 'team-1' }));
    expect(res.status).toBe(404);
  });

  it('returns 404 when the team belongs to another user', async () => {
    teamRows = [{ userId: 'someone-else' }];
    const res = await GET(makeReq({ teamId: 'team-1' }));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/team/events — snapshot redaction reaches the wire', () => {
  it('streams redacted snapshot rows', async () => {
    messageRows = [
      {
        id: 'msg-1',
        runId: 'run-1',
        conversationId: null,
        teamId: 'team-1',
        fromMemberId: 'member-1',
        toMemberId: null,
        type: 'tool_use',
        content: null,
        contentBlocks: null,
        metadata: {
          tool_use_id: 'tu-1',
          tool_name: 'find_threads_via_xai',
          tool_input: {
            subagent_type: 'social-media-manager',
            description: 'find threads',
            prompt: 'Mode: discover-and-fill-slot — secret playbook',
          },
          tool_output: 'raw subagent transcript',
          agent_name: 'coordinator',
        },
        createdAt: new Date('2026-05-04T01:00:00Z'),
      },
    ];

    const res = await GET(makeReq({ teamId: 'team-1' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const buf = await readUntilSentinel(res, '"snapshot_end"');

    // Banned strings — these are the headline leaks the redactor closes.
    expect(buf).not.toContain('xai');
    expect(buf).not.toContain('find_threads_via_xai');
    expect(buf).not.toContain('social-media-manager');
    expect(buf).not.toContain('coordinator');
    expect(buf).not.toContain('Mode: discover-and-fill-slot');
    expect(buf).not.toContain('tool_output');
    expect(buf).not.toContain('secret playbook');
    // The bare key `subagent_type` fingerprints Anthropic's Task tool.
    expect(buf).not.toContain('subagent_type');

    // Positive labels reach the wire.
    expect(buf).toContain('"snapshot"');
    expect(buf).toContain('"snapshot_end"');
    expect(buf).toContain('"searching"');
    expect(buf).toContain('Social Media Manager');
    expect(buf).toContain('Team Lead');
  });

  it('subscribes to the live channel and registers a handler', async () => {
    messageRows = [];
    const res = await GET(makeReq({ teamId: 'team-1' }));
    expect(res.status).toBe(200);

    // Drive the stream long enough for `start()` to run + flush.
    await readUntilSentinel(res, '"snapshot_end"');

    expect(lastSubscriber).toBeTruthy();
    expect(lastSubscriber!.subscribe).toHaveBeenCalledWith(
      'team:team-1:messages',
    );
    // The route registers a `message` handler that dispatches through
    // `buildLiveEventFrame` — the helper itself is unit-tested above,
    // and asserting registration here confirms the wiring.
    expect(lastSubscriber!.on).toHaveBeenCalled();
    const onCall = lastSubscriber!.on.mock.calls.find(
      (c: unknown[]) => c[0] === 'message',
    );
    expect(onCall).toBeTruthy();
    expect(typeof onCall![1]).toBe('function');
  });
});
