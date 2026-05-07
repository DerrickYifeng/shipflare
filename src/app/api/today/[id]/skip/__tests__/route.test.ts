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

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  loggerForRequest: () => ({
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    traceId: 't',
  }),
}));

// The route reads drafts when the plan_item lookup misses, then issues
// either a plan-item state transition (via writePlanItemState) or an
// UPDATE drafts (status='skipped'). We capture the table identity passed
// to `update()` so tests can assert which path ran without poking at SQL.
const draftLookupMock = vi.fn();
const lastDraftUpdate: {
  table: string | null;
  set: Record<string, unknown> | null;
} = { table: null, set: null };

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => draftLookupMock(),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (s: Record<string, unknown>) => ({
        where: () => {
          const id = (table as { __name?: string }).__name ?? 'unknown';
          lastDraftUpdate.table = id;
          lastDraftUpdate.set = s;
          return Promise.resolve();
        },
      }),
    }),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  drafts: { __name: 'drafts', id: 'id', userId: 'userId', status: 'status', updatedAt: 'updatedAt' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
  and: (...conds: unknown[]) => ({ conds }),
}));

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/today/11111111-1111-1111-1111-111111111111/skip', {
    method: 'PATCH',
  });
}

beforeEach(() => {
  authUserId = 'user-1';
  findMock.mockReset();
  writeMock.mockReset();
  draftLookupMock.mockReset();
  lastDraftUpdate.table = null;
  lastDraftUpdate.set = null;
});

describe('PATCH /api/today/[id]/skip', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq(), {
      params: Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 when the item is not owned', async () => {
    findMock.mockResolvedValueOnce(null);
    draftLookupMock.mockResolvedValueOnce([]);
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq(), {
      params: Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 200 on success', async () => {
    findMock.mockResolvedValueOnce({
      id: '11111111-1111-1111-1111-111111111111',
      userId: 'user-1',
      state: 'planned',
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
  });

  it('skips a pending reply draft when id is a drafts.id', async () => {
    findMock.mockResolvedValueOnce(null); // not a plan_item
    draftLookupMock.mockResolvedValueOnce([
      { id: '11111111-1111-1111-1111-111111111111', userId: 'user-1', status: 'pending' },
    ]);
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq(), {
      params: Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, source: 'draft' });
    expect(lastDraftUpdate.table).toBe('drafts');
    expect(lastDraftUpdate.set).toMatchObject({ status: 'skipped' });
  });

  it('returns 409 not_skippable when draft is past pending', async () => {
    findMock.mockResolvedValueOnce(null);
    draftLookupMock.mockResolvedValueOnce([
      { id: '11111111-1111-1111-1111-111111111111', userId: 'user-1', status: 'handed_off' },
    ]);
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq(), {
      params: Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'not_skippable', status: 'handed_off' });
    expect(lastDraftUpdate.table).toBeNull();
  });

  it('returns 404 when neither table owns the id', async () => {
    findMock.mockResolvedValueOnce(null);
    draftLookupMock.mockResolvedValueOnce([]);
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq(), {
      params: Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' }),
    });
    expect(res.status).toBe(404);
    expect(lastDraftUpdate.table).toBeNull();
  });
});
