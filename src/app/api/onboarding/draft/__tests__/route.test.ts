import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

const getDraftMock = vi.fn();
const putDraftMock = vi.fn();
const deleteDraftMock = vi.fn();

vi.mock('@/lib/onboarding-draft', () => ({
  getDraft: getDraftMock,
  putDraft: putDraftMock,
  deleteDraft: deleteDraftMock,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  loggerForRequest: () => ({
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    traceId: 'trace-test',
  }),
}));

function makeGet(): NextRequest {
  return new NextRequest('http://localhost/api/onboarding/draft', {
    method: 'GET',
  });
}

function makePut(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/onboarding/draft', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function makeDelete(): NextRequest {
  return new NextRequest('http://localhost/api/onboarding/draft', {
    method: 'DELETE',
  });
}

beforeEach(() => {
  authUserId = 'user-1';
  getDraftMock.mockReset();
  putDraftMock.mockReset();
  deleteDraftMock.mockReset();
});

describe('GET /api/onboarding/draft', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { GET } = await import('../route');
    const res = await GET(makeGet());
    expect(res.status).toBe(401);
  });

  it('returns { draft: null } when no draft exists', async () => {
    getDraftMock.mockResolvedValueOnce(null);
    const { GET } = await import('../route');
    const res = await GET(makeGet());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ draft: null });
  });

  it('returns the stored draft', async () => {
    const draft = { name: 'ShipFlare', state: 'mvp' };
    getDraftMock.mockResolvedValueOnce(draft);
    const { GET } = await import('../route');
    const res = await GET(makeGet());
    expect(await res.json()).toEqual({ draft });
  });
});

describe('PUT /api/onboarding/draft', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { PUT } = await import('../route');
    const res = await PUT(makePut({ name: 'x' }));
    expect(res.status).toBe(401);
  });

  it('rejects non-object bodies', async () => {
    const { PUT } = await import('../route');
    const res = await PUT(makePut(['array', 'not', 'object']));
    expect(res.status).toBe(400);
    expect(putDraftMock).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON', async () => {
    const badReq = new NextRequest('http://localhost/api/onboarding/draft', {
      method: 'PUT',
      body: '{not-json',
      headers: { 'content-type': 'application/json' },
    });
    const { PUT } = await import('../route');
    const res = await PUT(badReq);
    expect(res.status).toBe(400);
  });

  it('merges patch and returns the latest draft', async () => {
    const merged = { name: 'ShipFlare', state: 'mvp', updatedAt: 't' };
    putDraftMock.mockResolvedValueOnce(undefined);
    getDraftMock.mockResolvedValueOnce(merged);

    const { PUT } = await import('../route');
    const res = await PUT(makePut({ state: 'mvp' }));
    expect(res.status).toBe(200);
    expect(putDraftMock).toHaveBeenCalledWith('user-1', { state: 'mvp' });
    expect(await res.json()).toEqual({ draft: merged });
  });
});

describe('DELETE /api/onboarding/draft', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { DELETE } = await import('../route');
    const res = await DELETE(makeDelete());
    expect(res.status).toBe(401);
  });

  it('returns success=true and calls deleteDraft', async () => {
    deleteDraftMock.mockResolvedValueOnce(undefined);
    const { DELETE } = await import('../route');
    const res = await DELETE(makeDelete());
    expect(res.status).toBe(200);
    expect(deleteDraftMock).toHaveBeenCalledWith('user-1');
    expect(await res.json()).toEqual({ success: true });
  });
});
