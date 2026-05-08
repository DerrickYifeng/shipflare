import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

const getUserAboutPublicMock = vi.fn();
vi.mock('@/lib/reddit-client', () => ({
  RedditClient: {
    appOnly: () => ({ getUserAboutPublic: getUserAboutPublicMock }),
  },
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
    traceId: 'trace-test',
  }),
}));

import { POST } from '../route';
import { auth } from '@/lib/auth';

const authMock = auth as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  authMock.mockReset();
  getUserAboutPublicMock.mockReset();
  authMock.mockResolvedValue({ user: { id: 'user-1' } });
});

function makeReq(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/reddit/verify-handle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/reddit/verify-handle', () => {
  it('returns 401 when not authenticated', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ handle: 'foo' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid handle (too short)', async () => {
    const res = await POST(makeReq({ handle: 'fo' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid handle (special chars)', async () => {
    const res = await POST(makeReq({ handle: 'foo@bar' }));
    expect(res.status).toBe(400);
  });

  it('returns { exists: true, karma } when handle exists', async () => {
    getUserAboutPublicMock.mockResolvedValueOnce({
      name: 'foo',
      total_karma: 1500,
      created_utc: 1700000000,
    });
    const res = await POST(makeReq({ handle: 'foo' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exists: true, karma: 1500 });
  });

  it('returns { exists: false } on 404', async () => {
    getUserAboutPublicMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ handle: 'foo' }));
    expect(await res.json()).toEqual({ exists: false });
  });

  it('returns { exists: null, error } on transient failure', async () => {
    getUserAboutPublicMock.mockRejectedValueOnce(new Error('HTTP 503'));
    const res = await POST(makeReq({ handle: 'foo' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      exists: null,
      error: 'reddit_unavailable',
    });
  });

  it('strips leading u/ from handle', async () => {
    getUserAboutPublicMock.mockResolvedValueOnce({
      name: 'foo',
      total_karma: 100,
      created_utc: 0,
    });
    await POST(makeReq({ handle: 'u/foo' }));
    expect(getUserAboutPublicMock).toHaveBeenCalledWith('foo');
  });

  it('strips leading /U/ (case-insensitive) from handle', async () => {
    getUserAboutPublicMock.mockResolvedValueOnce({
      name: 'foo',
      total_karma: 100,
      created_utc: 0,
    });
    await POST(makeReq({ handle: '/U/foo' }));
    expect(getUserAboutPublicMock).toHaveBeenCalledWith('foo');
  });
});
