import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Minimal stub of the ioredis-shaped client our production code uses.
// Hand-rolled instead of vi.mock'd factory because we want the second
// test ("already locked") to share state with the first.
const kvStore = new Map<string, { value: string; expiresAt: number }>();

const kvMock = {
  set: vi.fn(
    async (
      key: string,
      value: string,
      _ex: string,
      ttlSeconds: number,
      nx: string,
    ) => {
      const now = Date.now();
      const existing = kvStore.get(key);
      if (existing && existing.expiresAt > now && nx === 'NX') return null;
      kvStore.set(key, {
        value,
        expiresAt: now + ttlSeconds * 1000,
      });
      return 'OK';
    },
  ),
  ttl: vi.fn(async (key: string) => {
    const now = Date.now();
    const entry = kvStore.get(key);
    if (!entry || entry.expiresAt <= now) return -2;
    return Math.ceil((entry.expiresAt - now) / 1000);
  }),
};

vi.mock('@/lib/redis', () => ({
  getKeyValueClient: () => kvMock,
}));

beforeEach(() => {
  kvStore.clear();
  kvMock.set.mockClear();
  kvMock.ttl.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('acquireRateLimit', () => {
  it('allows the first call within a window', async () => {
    const { acquireRateLimit } = await import('../rate-limit');
    const res = await acquireRateLimit('k1', 10);
    expect(res.allowed).toBe(true);
    expect(res.retryAfterSeconds).toBe(0);
  });

  it('rejects the second call with retryAfter > 0', async () => {
    const { acquireRateLimit } = await import('../rate-limit');
    await acquireRateLimit('k2', 10);
    const second = await acquireRateLimit('k2', 10);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
    expect(second.retryAfterSeconds).toBeLessThanOrEqual(10);
  });

  it('allows different keys independently', async () => {
    const { acquireRateLimit } = await import('../rate-limit');
    const a = await acquireRateLimit('kA', 10);
    const b = await acquireRateLimit('kB', 10);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });

  it('throws when windowSeconds <= 0', async () => {
    const { acquireRateLimit } = await import('../rate-limit');
    await expect(acquireRateLimit('k', 0)).rejects.toThrow();
    await expect(acquireRateLimit('k', -5)).rejects.toThrow();
  });

  it('fails open on redis error (returns allowed=true)', async () => {
    const { acquireRateLimit } = await import('../rate-limit');
    kvMock.set.mockRejectedValueOnce(new Error('redis down'));
    const res = await acquireRateLimit('k3', 10);
    expect(res.allowed).toBe(true);
    expect(res.retryAfterSeconds).toBe(0);
  });
});
