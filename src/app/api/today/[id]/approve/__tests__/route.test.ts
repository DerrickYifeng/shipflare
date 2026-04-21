import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

const findMock = vi.fn();
const writeMock = vi.fn();
vi.mock('@/app/api/plan-item/[id]/_helpers', () => ({
  findOwnedPlanItem: (id: string, userId: string) => findMock(id, userId),
  writePlanItemState: (row: unknown, to: string) => writeMock(row, to),
  paramsSchema: {
    safeParse: (v: { id: string }) => ({
      success: /^[0-9a-f-]{36}$/.test(v.id),
      data: v,
    }),
  },
}));

const enqueueMock = vi.fn(async (_data: unknown) => undefined);
vi.mock('@/lib/queue', () => ({
  enqueuePlanExecute: (data: unknown) => enqueueMock(data),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  loggerForRequest: () => ({
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    traceId: 't',
  }),
}));

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/today/11111111-1111-1111-1111-111111111111/approve', {
    method: 'PATCH',
  });
}

beforeEach(() => {
  authUserId = 'user-1';
  findMock.mockReset();
  writeMock.mockReset();
  enqueueMock.mockReset();
});

describe('PATCH /api/today/[id]/approve', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq(), {
      params: Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid uuid', async () => {
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq(), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the item is not owned', async () => {
    findMock.mockResolvedValueOnce(null);
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq(), {
      params: Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' }),
    });
    expect(res.status).toBe(404);
  });

  it('enqueues execute and returns 200 on success', async () => {
    findMock.mockResolvedValueOnce({
      id: '11111111-1111-1111-1111-111111111111',
      userId: 'user-1',
      state: 'ready_for_review',
      userAction: 'approve',
      kind: 'content_post',
      channel: 'x',
      skillName: null,
    });
    writeMock.mockResolvedValueOnce(null);
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq(), {
      params: Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' }),
    });
    expect(res.status).toBe(200);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });
});
