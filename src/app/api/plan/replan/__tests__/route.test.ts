import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let allowedRL = true;
vi.mock('@/lib/rate-limit', () => ({
  acquireRateLimit: vi.fn(async () => ({
    allowed: allowedRL,
    retryAfterSeconds: allowedRL ? 0 : 7,
  })),
}));

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  loggerForRequest: () => ({
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    traceId: 'trace-test',
  }),
}));

// re-plan.ts is mocked wholesale — its own unit tests cover the supersede
// / enqueue flow. The route test only exercises the HTTP surface.
const runTacticalReplanMock = vi.fn();
vi.mock('@/lib/re-plan', () => ({
  runTacticalReplan: (userId: string, trigger: 'manual' | 'weekly') =>
    runTacticalReplanMock(userId, trigger),
}));

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/plan/replan', { method: 'POST' });
}

beforeEach(() => {
  allowedRL = true;
  authUserId = 'user-1';
  runTacticalReplanMock.mockReset();
});

describe('POST /api/plan/replan', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { POST } = await import('../route');
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate-limited', async () => {
    allowedRL = false;
    const { POST } = await import('../route');
    const res = await POST(makeReq());
    expect(res.status).toBe(429);
  });

  it('returns 404 when runTacticalReplan reports no_active_path', async () => {
    runTacticalReplanMock.mockResolvedValueOnce({ ok: false, code: 'no_active_path' });
    const { POST } = await import('../route');
    const res = await POST(makeReq());
    expect(res.status).toBe(404);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('no_active_path');
  });

  it('returns 400 when runTacticalReplan reports no_channels_in_path', async () => {
    runTacticalReplanMock.mockResolvedValueOnce({
      ok: false,
      code: 'no_channels_in_path',
    });
    const { POST } = await import('../route');
    const res = await POST(makeReq());
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('no_channels_in_path');
  });

  it('returns 500 when the team-run enqueue fails', async () => {
    runTacticalReplanMock.mockResolvedValueOnce({
      ok: false,
      code: 'team_run_enqueue_failed',
      detail: 'redis down',
    });
    const { POST } = await import('../route');
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const payload = (await res.json()) as { error: string; detail?: string };
    expect(payload.error).toBe('replan_failed');
    expect(payload.detail).toBe('redis down');
  });

  it('returns 200 with runId + itemsSuperseded on success', async () => {
    runTacticalReplanMock.mockResolvedValueOnce({
      ok: true,
      runId: 'run-abc',
      itemsSuperseded: 5,
    });
    const { POST } = await import('../route');
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      runId: string;
      itemsSuperseded: number;
    };
    expect(payload.runId).toBe('run-abc');
    expect(payload.itemsSuperseded).toBe(5);
  });

  it('passes trigger=manual to runTacticalReplan', async () => {
    runTacticalReplanMock.mockResolvedValueOnce({
      ok: true,
      runId: 'run-1',
      itemsSuperseded: 0,
    });
    const { POST } = await import('../route');
    await POST(makeReq());
    expect(runTacticalReplanMock).toHaveBeenCalledWith('user-1', 'manual');
  });
});
