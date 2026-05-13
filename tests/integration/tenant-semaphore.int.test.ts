import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import IORedis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { acquireTenantSlot, releaseTenantSlot } from '@/lib/redis-scripts/tenant-semaphore';

/**
 * Integration test for the per-tenant in-flight semaphore.
 *
 * Requires a running Redis. The integration setup (`bullmq.setup.ts`) points
 * `REDIS_URL` at port 6390. We open a fresh client here so the test owns its
 * own keys and connection lifecycle.
 */

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6390';
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const userId = `test-user-${randomUUID()}`;

beforeEach(async () => {
  await redis.del(`inflight:agent:${userId}`);
});

afterAll(async () => {
  await redis.del(`inflight:agent:${userId}`);
  await redis.quit();
});

describe('tenant-semaphore', () => {
  it('acquires up to cap, refuses beyond, releases let next through', async () => {
    const cap = 3;
    const ttl = 60;
    const a = await acquireTenantSlot(redis, userId, cap, ttl);
    const b = await acquireTenantSlot(redis, userId, cap, ttl);
    const c = await acquireTenantSlot(redis, userId, cap, ttl);
    const d = await acquireTenantSlot(redis, userId, cap, ttl);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    expect(c.acquired).toBe(true);
    expect(d.acquired).toBe(false);
    expect(d.current).toBe(3);
    expect(d.cap).toBe(3);

    await releaseTenantSlot(redis, userId);
    const e = await acquireTenantSlot(redis, userId, cap, ttl);
    expect(e.acquired).toBe(true);
  });

  it('release floors at 0 (no negative counts)', async () => {
    // No prior acquire — releasing should not produce a negative GET.
    await releaseTenantSlot(redis, userId);
    await releaseTenantSlot(redis, userId);

    const raw = await redis.get(`inflight:agent:${userId}`);
    // Either '0' (after the floor) or null (key never set / cleared); both are fine.
    if (raw !== null) {
      expect(Number(raw)).toBeGreaterThanOrEqual(0);
    }

    // Acquiring after over-release should still work and report current=1.
    const a = await acquireTenantSlot(redis, userId, 2, 60);
    expect(a.acquired).toBe(true);
    expect(a.current).toBe(1);
  });

  it('sets a TTL so a crashed worker cannot permanently leak a slot', async () => {
    const cap = 2;
    const ttl = 60;
    await acquireTenantSlot(redis, userId, cap, ttl);

    const remaining = await redis.ttl(`inflight:agent:${userId}`);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(ttl);
  });
});
