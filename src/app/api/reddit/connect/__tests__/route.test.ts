import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

const valuesMock = vi.fn();
const onConflictDoUpdateMock = vi.fn();
const insertMock = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    insert: (...args: unknown[]) => insertMock(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { POST } from '../route';
import { auth } from '@/lib/auth';

const authMock = auth as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  authMock.mockReset();
  insertMock.mockReset();
  valuesMock.mockReset();
  onConflictDoUpdateMock.mockReset();

  authMock.mockResolvedValue({ user: { id: 'user-1' } });

  // db.insert(table).values({...}).onConflictDoUpdate({...})
  onConflictDoUpdateMock.mockResolvedValue(undefined);
  valuesMock.mockReturnValue({ onConflictDoUpdate: onConflictDoUpdateMock });
  insertMock.mockReturnValue({ values: valuesMock });
});

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/reddit/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/reddit/connect', () => {
  it('returns 401 when not authenticated', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ handle: 'foo' }));
    expect(res.status).toBe(401);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid handle (too short)', async () => {
    const res = await POST(makeReq({ handle: 'fo' }));
    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid handle (special chars)', async () => {
    const res = await POST(makeReq({ handle: 'foo@bar' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for non-JSON body', async () => {
    const req = new Request('http://localhost/api/reddit/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('upserts channels row for valid handle and returns 200', async () => {
    const res = await POST(makeReq({ handle: 'founder123' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(valuesMock).toHaveBeenCalledTimes(1);

    const inserted = valuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.userId).toBe('user-1');
    expect(inserted.platform).toBe('reddit');
    expect(inserted.username).toBe('founder123');
    expect(inserted.oauthTokenEncrypted).toBeNull();
    expect(inserted.refreshTokenEncrypted).toBeNull();

    expect(onConflictDoUpdateMock).toHaveBeenCalledTimes(1);
    const conflictArg = onConflictDoUpdateMock.mock.calls[0][0] as {
      target: unknown;
      set: { username: string; updatedAt: Date };
    };
    expect(conflictArg.set.username).toBe('founder123');
    expect(conflictArg.set.updatedAt).toBeInstanceOf(Date);
  });
});
