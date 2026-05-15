import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

const draftLookupMock = vi.fn();
const updateMock = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    query: { drafts: { findFirst: () => draftLookupMock() } },
    update: () => ({
      set: (s: Record<string, unknown>) => ({
        where: () => updateMock(s),
      }),
    }),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  drafts: { __name: 'drafts', id: 'id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
  }),
  loggerForRequest: () => ({
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    traceId: 't',
  }),
}));

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/draft/d-1/handoff-confirm', {
    method: 'POST',
  });
}

beforeEach(() => {
  authUserId = 'user-1';
  draftLookupMock.mockReset();
  updateMock.mockReset();
});

describe('POST /api/draft/[id]/handoff-confirm', () => {
  it('returns 401 when not authenticated', async () => {
    authUserId = null;
    const { POST } = await import('../route');
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 when draft does not exist', async () => {
    draftLookupMock.mockResolvedValueOnce(null);
    const { POST } = await import('../route');
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 403 when draft is not owned by the caller', async () => {
    draftLookupMock.mockResolvedValueOnce({
      id: 'd-1',
      userId: 'someone-else',
      status: 'pending',
    });
    const { POST } = await import('../route');
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('flips status from pending → handed_off', async () => {
    draftLookupMock.mockResolvedValueOnce({
      id: 'd-1',
      userId: 'user-1',
      status: 'pending',
    });
    updateMock.mockResolvedValueOnce(undefined);
    const { POST } = await import('../route');
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'handed_off' }),
    );
  });

  it('flips status from approved → handed_off', async () => {
    draftLookupMock.mockResolvedValueOnce({
      id: 'd-1',
      userId: 'user-1',
      status: 'approved',
    });
    updateMock.mockResolvedValueOnce(undefined);
    const { POST } = await import('../route');
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on already-handed_off (returns 200, no UPDATE)', async () => {
    draftLookupMock.mockResolvedValueOnce({
      id: 'd-1',
      userId: 'user-1',
      status: 'handed_off',
    });
    const { POST } = await import('../route');
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ alreadyHandedOff: true });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 409 for terminal-bad statuses (posted)', async () => {
    draftLookupMock.mockResolvedValueOnce({
      id: 'd-1',
      userId: 'user-1',
      status: 'posted',
    });
    const { POST } = await import('../route');
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(409);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns 409 for failed status', async () => {
    draftLookupMock.mockResolvedValueOnce({
      id: 'd-1',
      userId: 'user-1',
      status: 'failed',
    });
    const { POST } = await import('../route');
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(409);
  });

  it('returns 409 for flagged status', async () => {
    draftLookupMock.mockResolvedValueOnce({
      id: 'd-1',
      userId: 'user-1',
      status: 'flagged',
    });
    const { POST } = await import('../route');
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'd-1' }) });
    expect(res.status).toBe(409);
  });
});
