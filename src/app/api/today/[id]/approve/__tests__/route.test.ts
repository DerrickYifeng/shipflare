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

// dbSelectMock is called once per chained .select() query in the route.
// Each call must return the value for that particular query in sequence.
const dbSelectMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: () => dbSelectMock(),
          }),
        }),
        where: () => ({
          limit: () => dbSelectMock(),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  },
}));

const dispatchMock = vi.fn();
vi.mock('@/lib/approve-dispatch', () => ({
  dispatchApprove: (input: unknown) => dispatchMock(input),
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
  dbSelectMock.mockReset();
  dispatchMock.mockReset();
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

  it('returns 404 when the item is not owned and no draft exists', async () => {
    // plan_item not found; draft fallback also returns nothing
    findMock.mockResolvedValueOnce(null);
    dbSelectMock.mockResolvedValueOnce([]); // loadDispatchInputForDraft: drafts join threads → no row
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq(), {
      params: Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' }),
    });
    expect(res.status).toBe(404);
  });

  it('falls back to legacy enqueue when plan_item has no linked draft', async () => {
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
    // findDraftForPlanItem returns no row → legacy enqueue path
    dbSelectMock.mockResolvedValueOnce([]);
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq(), {
      params: Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' }),
    });
    expect(res.status).toBe(200);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toEqual({ success: true });
  });
});
