import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Phase E end-to-end roundtrip — the founder UI POSTs /api/team/run with a
// goal, and the route must (in order):
//   1. ensureLeadAgentRun(teamId) → leadAgentId (idempotent)
//   2. INSERT into team_messages with toAgentId=leadAgentId, content=goal,
//      type='user_prompt', messageType='message'
//   3. wake(leadAgentId) — single BullMQ enqueue point
//
// We stub the db, auth, ensureLeadAgentRun, and wake — the assertion target
// is the *trigger chain*, not drizzle SQL or BullMQ wiring (those have their
// own unit tests under src/lib/team/__tests__/spawn-lead.test.ts and
// src/workers/processors/lib/__tests__/wake.test.ts in spirit).
// ---------------------------------------------------------------------------

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
}));

const ensureLeadAgentRunMock = vi.fn(async (_teamId: string) => ({
  agentId: 'lead-agent-1',
}));
vi.mock('@/lib/team/spawn-lead', () => ({
  ensureLeadAgentRun: (teamId: string, _db: unknown) =>
    ensureLeadAgentRunMock(teamId),
}));

const wakeMock = vi.fn(async (_agentId: string) => undefined);
vi.mock('@/workers/processors/lib/wake', () => ({
  wake: wakeMock,
}));

// Drizzle eq/and — we don't care about the actual SQL; just the shape of the
// where-clause is irrelevant here because the db mock returns canned rows.
vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (_col: unknown, value: unknown) => ({ __eqValue: value as string }),
    and: (..._args: unknown[]) => ({ __and: true }),
  };
});

// db mock — the route's own SELECTs (teams / teamMembers / teamConversations
// / products) get canned rows. The INSERT into team_messages records its
// payload via teamMessagesInsertSpy so we can assert on it. ensureLeadAgentRun
// is fully mocked above, so its internal db calls are bypassed.
const teamMessagesInsertSpy = vi.fn();
let teamRow: { id: string; userId: string; productId: string | null } | null = {
  id: 'team-1',
  userId: 'user-1',
  productId: 'prod-1',
};
let coordinatorMember: { id: string } | null = { id: 'member-coord' };
let conversationRow: { id: string } | null = { id: 'conv-1' };
let productRow: { name: string; state: string } | null = {
  name: 'ShipFlare',
  state: 'mvp',
};

vi.mock('@/lib/db', () => ({
  db: {
    select: (projection?: unknown) => {
      const sel = projection as Record<string, unknown> | undefined;
      const fields = sel ? Object.keys(sel) : [];
      return {
        from: (_table: unknown) => ({
          where: (_cond: unknown) => ({
            limit: (_n: number) => {
              // Order matters in the route, but distinguishing by
              // projection field-set is more robust than call-index.
              if (fields.includes('userId') && fields.includes('productId')) {
                // teams lookup
                return teamRow ? [teamRow] : [];
              }
              if (
                fields.includes('name') &&
                fields.includes('state') &&
                fields.length === 2
              ) {
                // products lookup (only when goal === '')
                return productRow ? [productRow] : [];
              }
              if (fields.length === 1 && fields[0] === 'id') {
                // Either teamConversations or teamMembers — both project
                // only `{ id }`. The route calls them in a fixed order
                // when no rootMemberId is supplied:
                //   1. teamMembers (coordinator)
                //   2. teamConversations
                // But _conditional_ on rootMemberId: only conversations
                // call happens. We track call order via a counter local
                // to this mock so both code paths work.
                idOnlyCallIndex++;
                if (idOnlyCallIndex === 1) {
                  return coordinatorMember ? [coordinatorMember] : [];
                }
                return conversationRow ? [conversationRow] : [];
              }
              return [];
            },
          }),
        }),
      };
    },
    insert: (_table: unknown) => ({
      values: async (vals: unknown) => {
        teamMessagesInsertSpy(vals);
        return undefined;
      },
    }),
  },
}));

let idOnlyCallIndex = 0;

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/team/run', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  authUserId = 'user-1';
  teamRow = { id: 'team-1', userId: 'user-1', productId: 'prod-1' };
  coordinatorMember = { id: 'member-coord' };
  conversationRow = { id: 'conv-1' };
  productRow = { name: 'ShipFlare', state: 'mvp' };
  idOnlyCallIndex = 0;
  ensureLeadAgentRunMock.mockClear();
  ensureLeadAgentRunMock.mockResolvedValue({ agentId: 'lead-agent-1' });
  wakeMock.mockClear();
  teamMessagesInsertSpy.mockClear();
});

describe('POST /api/team/run — Phase E founder UI roundtrip', () => {
  it('triggers the full chain: ensureLeadAgentRun → team_messages insert → wake', async () => {
    const { POST } = await import('../route');
    const goal = 'Plan the launch strategy for ShipFlare';
    const res = await POST(
      makeRequest({
        teamId: 'team-1',
        goal,
        conversationId: 'conv-1',
      }),
    );

    expect(res.status).toBe(202);

    // 1. ensureLeadAgentRun called with teamId
    expect(ensureLeadAgentRunMock).toHaveBeenCalledOnce();
    expect(ensureLeadAgentRunMock).toHaveBeenCalledWith('team-1');

    // 2. team_messages insert has the expected shape
    expect(teamMessagesInsertSpy).toHaveBeenCalledOnce();
    const inserted = teamMessagesInsertSpy.mock.calls[0][0] as {
      teamId: string;
      conversationId: string;
      fromMemberId: string | null;
      toMemberId: string | null;
      toAgentId: string;
      type: string;
      messageType: string;
      content: string;
      contentBlocks: Array<{ type: string; text: string }>;
      summary: string;
    };
    expect(inserted.teamId).toBe('team-1');
    expect(inserted.conversationId).toBe('conv-1');
    expect(inserted.fromMemberId).toBeNull();
    expect(inserted.toMemberId).toBeNull();
    expect(inserted.toAgentId).toBe('lead-agent-1');
    expect(inserted.type).toBe('user_prompt');
    expect(inserted.messageType).toBe('message');
    expect(inserted.content).toBe(goal);
    expect(inserted.contentBlocks).toEqual([{ type: 'text', text: goal }]);

    // 3. wake called with the lead agent id (single BullMQ enqueue point)
    expect(wakeMock).toHaveBeenCalledOnce();
    expect(wakeMock).toHaveBeenCalledWith('lead-agent-1');

    // 4. response shape: runId is the new message id, traceId is the lead.
    const payload = (await res.json()) as {
      runId: string;
      traceId: string;
      alreadyRunning: boolean;
      conversationId: string;
    };
    expect(payload.traceId).toBe('lead-agent-1');
    expect(payload.alreadyRunning).toBe(false);
    expect(payload.conversationId).toBe('conv-1');
    expect(typeof payload.runId).toBe('string');
    expect(payload.runId.length).toBeGreaterThan(0);
  });

  it('derives a goal from trigger=daily when goal is empty (still wakes lead)', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      makeRequest({
        teamId: 'team-1',
        goal: '',
        trigger: 'daily',
        conversationId: 'conv-1',
      }),
    );

    expect(res.status).toBe(202);

    // Goal was derived — content is non-empty and references the product name.
    const inserted = teamMessagesInsertSpy.mock.calls[0][0] as {
      content: string;
    };
    expect(inserted.content.length).toBeGreaterThan(0);
    expect(inserted.content).toContain('ShipFlare');

    // The chain still fires.
    expect(ensureLeadAgentRunMock).toHaveBeenCalledWith('team-1');
    expect(wakeMock).toHaveBeenCalledWith('lead-agent-1');
  });

  it('returns 401 when unauthenticated and skips the chain entirely', async () => {
    authUserId = null;
    const { POST } = await import('../route');
    const res = await POST(
      makeRequest({
        teamId: 'team-1',
        goal: 'hi',
        conversationId: 'conv-1',
      }),
    );
    expect(res.status).toBe(401);
    expect(ensureLeadAgentRunMock).not.toHaveBeenCalled();
    expect(teamMessagesInsertSpy).not.toHaveBeenCalled();
    expect(wakeMock).not.toHaveBeenCalled();
  });

  it('returns 404 and skips the chain when the team belongs to another user', async () => {
    teamRow = { id: 'team-1', userId: 'other-user', productId: 'prod-1' };
    const { POST } = await import('../route');
    const res = await POST(
      makeRequest({
        teamId: 'team-1',
        goal: 'hi',
        conversationId: 'conv-1',
      }),
    );
    expect(res.status).toBe(404);
    expect(ensureLeadAgentRunMock).not.toHaveBeenCalled();
    expect(wakeMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the conversation is not found', async () => {
    conversationRow = null;
    const { POST } = await import('../route');
    const res = await POST(
      makeRequest({
        teamId: 'team-1',
        goal: 'hi',
        conversationId: 'conv-missing',
      }),
    );
    expect(res.status).toBe(404);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('conversation_not_found');
    expect(ensureLeadAgentRunMock).not.toHaveBeenCalled();
    expect(wakeMock).not.toHaveBeenCalled();
  });
});
