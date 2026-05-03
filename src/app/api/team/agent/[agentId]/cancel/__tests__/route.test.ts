// UI-B Task 11 — endpoint contract test for /api/team/agent/[agentId]/cancel.
//
// Mocks `cancelTeammate` and the auth + ownership query so the test
// verifies the route's auth + 404 + 200 paths without booting Postgres
// or BullMQ.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

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

const cancelTeammateMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/team/cancel-teammate', () => ({
  cancelTeammate: cancelTeammateMock,
}));

import { POST } from '../route';

beforeEach(() => {
  authUserId = 'user-1';
  ownerRows = [{ userId: 'user-1' }];
  cancelTeammateMock.mockReset();
  cancelTeammateMock.mockResolvedValue(undefined);
});

function makeReq(): NextRequest {
  return new NextRequest('http://test/api/team/agent/agent-1/cancel', {
    method: 'POST',
  });
}

function makeParams(agentId: string) {
  return { params: Promise.resolve({ agentId }) };
}

describe('POST /api/team/agent/[agentId]/cancel', () => {
  it('rejects unauthenticated requests with 401', async () => {
    authUserId = null;
    const res = await POST(makeReq(), makeParams('agent-1'));
    expect(res.status).toBe(401);
    expect(cancelTeammateMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the agent_runs row does not exist', async () => {
    ownerRows = [];
    const res = await POST(makeReq(), makeParams('agent-1'));
    expect(res.status).toBe(404);
    expect(cancelTeammateMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the agent belongs to another user (no existence leak)', async () => {
    ownerRows = [{ userId: 'someone-else' }];
    const res = await POST(makeReq(), makeParams('agent-1'));
    expect(res.status).toBe(404);
    expect(cancelTeammateMock).not.toHaveBeenCalled();
  });

  it('returns 200 with { cancelled, agentId } on success', async () => {
    const res = await POST(makeReq(), makeParams('agent-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ cancelled: true, agentId: 'agent-1' });
    expect(cancelTeammateMock).toHaveBeenCalledOnce();
    expect(cancelTeammateMock).toHaveBeenCalledWith('agent-1', expect.anything());
  });

  it('passes the agentId through from the route param', async () => {
    await POST(makeReq(), makeParams('agent-xyz'));
    expect(cancelTeammateMock).toHaveBeenCalledWith('agent-xyz', expect.anything());
  });

  it('maps a "not found" race from the helper to a 404', async () => {
    cancelTeammateMock.mockRejectedValue(
      new Error('agent_runs agent-1 not found'),
    );
    const res = await POST(makeReq(), makeParams('agent-1'));
    expect(res.status).toBe(404);
  });

  it('returns 500 when the helper throws unexpectedly', async () => {
    cancelTeammateMock.mockRejectedValue(new Error('redis unreachable'));
    const res = await POST(makeReq(), makeParams('agent-1'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('cancel_failed');
  });
});
