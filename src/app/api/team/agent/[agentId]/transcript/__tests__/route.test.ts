// UI-B Task 9 — endpoint contract test for /api/team/agent/[agentId]/transcript.
//
// Mocks `loadAgentRunHistory` and the auth + ownership query so the
// test verifies the route's auth + shaping behavior (content coercion,
// 401/404 paths) without booting Postgres.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type Anthropic from '@anthropic-ai/sdk';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

type OwnerRow = { userId: string };

let ownerRows: OwnerRow[] = [];

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: () => Promise.resolve(ownerRows),
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
  };
});

const loadAgentRunHistoryMock = vi.hoisted(() => vi.fn());
vi.mock('@/workers/processors/lib/agent-run-history', () => ({
  loadAgentRunHistory: loadAgentRunHistoryMock,
}));

import { GET } from '../route';

beforeEach(() => {
  authUserId = 'user-1';
  ownerRows = [{ userId: 'user-1' }];
  loadAgentRunHistoryMock.mockReset();
  loadAgentRunHistoryMock.mockResolvedValue([] as Anthropic.Messages.MessageParam[]);
});

function makeReq(): NextRequest {
  return new NextRequest('http://test/api/team/agent/agent-1/transcript');
}

function makeParams(agentId: string) {
  return { params: Promise.resolve({ agentId }) };
}

describe('GET /api/team/agent/[agentId]/transcript', () => {
  it('rejects unauthenticated requests with 401', async () => {
    authUserId = null;
    const res = await GET(makeReq(), makeParams('agent-1'));
    expect(res.status).toBe(401);
  });

  it('returns 404 when the agent_runs row does not exist', async () => {
    ownerRows = [];
    const res = await GET(makeReq(), makeParams('agent-1'));
    expect(res.status).toBe(404);
    expect(loadAgentRunHistoryMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the agent belongs to another user (no existence leak)', async () => {
    ownerRows = [{ userId: 'someone-else' }];
    const res = await GET(makeReq(), makeParams('agent-1'));
    expect(res.status).toBe(404);
    expect(loadAgentRunHistoryMock).not.toHaveBeenCalled();
  });

  it('returns the loaded history verbatim when content is plain text', async () => {
    loadAgentRunHistoryMock.mockResolvedValue([
      { role: 'user', content: 'kick off draft' },
      { role: 'assistant', content: 'here are 3 variations' },
    ] as Anthropic.Messages.MessageParam[]);
    const res = await GET(makeReq(), makeParams('agent-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([
      { role: 'user', content: 'kick off draft' },
      { role: 'assistant', content: 'here are 3 variations' },
    ]);
  });

  it('coerces structured content blocks to JSON strings', async () => {
    loadAgentRunHistoryMock.mockResolvedValue([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
      },
    ] as Anthropic.Messages.MessageParam[]);
    const res = await GET(makeReq(), makeParams('agent-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(1);
    expect(typeof body.messages[0].content).toBe('string');
    // Content is JSON.stringified, so the original block survives a parse.
    const parsed = JSON.parse(body.messages[0].content);
    expect(parsed).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('returns an empty messages array for an agent with no history', async () => {
    loadAgentRunHistoryMock.mockResolvedValue([] as Anthropic.Messages.MessageParam[]);
    const res = await GET(makeReq(), makeParams('agent-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });

  it('passes the agentId through to loadAgentRunHistory', async () => {
    await GET(makeReq(), makeParams('agent-xyz'));
    expect(loadAgentRunHistoryMock).toHaveBeenCalledWith('agent-xyz', expect.anything());
  });
});
