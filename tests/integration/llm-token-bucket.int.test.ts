import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import IORedis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { tryAcquireLlmTokens } from '@/lib/redis-scripts/llm-token-bucket';

/**
 * Integration test for the two-level Anthropic token bucket.
 *
 * Requires a running Redis. The integration setup (`bullmq.setup.ts`) points
 * `REDIS_URL` at port 6390. We open a fresh client here so the test owns its
 * own keys and connection lifecycle.
 */

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6390';
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const userId = `test-user-${randomUUID()}`;
const tenantKey = `llm:tenant:${userId}`;
// Unique global key per run so parallel test runs don't interfere with each other.
const globalKey = `llm:global:test-${randomUUID()}`;

beforeEach(async () => {
  await redis.del(tenantKey, globalKey);
});

afterAll(async () => {
  await redis.del(tenantKey, globalKey);
  await redis.quit();
});

describe('llm-token-bucket', () => {
  it('allows up to tenant cap, then denies with retry_ms (tenant-denied path)', async () => {
    // Tenant has 5 slots, global is effectively unlimited within this test.
    const opts = {
      tenantKey,
      tenantCap: 5,
      tenantRefillPerSec: 0.1, // 10s per token
      globalKey,
      globalCap: 1000,
      globalRefillPerSec: 100,
    };
    for (let i = 0; i < 5; i++) {
      const r = await tryAcquireLlmTokens(redis, opts);
      expect(r.allowed).toBe(true);
      // Narrow past failedOpen to reach tenantRemaining (real Redis is up
      // in this test; we should be on the happy-path arm).
      if (r.allowed && !r.failedOpen) {
        expect(r.tenantRemaining).toBeGreaterThanOrEqual(0);
        // Each acquire drops the count by 1 (modulo a tiny refill amount).
        expect(r.tenantRemaining).toBeLessThan(5);
      }
    }
    const denied = await tryAcquireLlmTokens(redis, opts);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.scope).toBe('tenant');
      expect(denied.retryMs).toBeGreaterThan(0);
      // Need 1 token at 0.1/sec → ~10000ms; the script returns ceil() so
      // give it a generous lower bound to avoid flake from accumulated refill.
      expect(denied.retryMs).toBeLessThanOrEqual(10_000);
    }
  });

  it('global-denied path refunds the tenant (no over-consumption)', async () => {
    // Tenant: huge cap. Global: only 2 slots. The third call must be denied
    // by `global`, and the tenant's token count must remain at "2 consumed"
    // (the refund undoes the third would-be consumption).
    const opts = {
      tenantKey,
      tenantCap: 100,
      tenantRefillPerSec: 0, // disable refill so we can verify exact balance
      globalKey,
      globalCap: 2,
      globalRefillPerSec: 0,
    };
    const r1 = await tryAcquireLlmTokens(redis, opts);
    const r2 = await tryAcquireLlmTokens(redis, opts);
    const r3 = await tryAcquireLlmTokens(redis, opts);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false);
    if (!r3.allowed) {
      expect(r3.scope).toBe('global');
      // refill=0 means the Lua "rate_per_sec <= 0" guard returns 60000ms.
      expect(r3.retryMs).toBe(60_000);
    }

    // Verify the tenant bucket only debited 2 (the two allowed calls), not 3.
    // Without the refund, we'd see tokens=97. With it, we see tokens=98.
    const tenantTokens = Number(await redis.hget(tenantKey, 't'));
    expect(tenantTokens).toBe(98);
  });

  it('global-deny refund restores ts — no double-credit on next refill', async () => {
    // I1 regression: if the refund leaves `ts = now_ms` instead of restoring
    // the pre-refill timestamp, the interval [prior_ts, now_ms] is credited
    // both via the refund (which restored tokens for that window) and again
    // on the next refill computation — double-credit.
    //
    // Setup: partial drain (5 → 3), then trigger a global-deny refund at
    // t=2000ms, then advance time and acquire again. Tokens after the final
    // acquire must equal "tokens at the original prior_ts" + (full elapsed
    // refill) - 1 (cost of the final acquire), NOT that plus an extra refill
    // window.
    const tenantOpts = {
      tenantKey,
      tenantCap: 5,
      tenantRefillPerSec: 1, // 1 token/sec
      globalKey,
      globalCap: 10, // start with capacity so partial-drain step works
      globalRefillPerSec: 0,
    };

    // Drain tenant from 5 → 3 (cost=1 each) at t=0, global stays at 10/9/8.
    const a1 = await tryAcquireLlmTokens(redis, { ...tenantOpts, nowMs: 0 });
    const a2 = await tryAcquireLlmTokens(redis, { ...tenantOpts, nowMs: 0 });
    expect(a1.allowed).toBe(true);
    expect(a2.allowed).toBe(true);

    // Burn the global bucket down to 0 so the next acquire is global-denied.
    // Use a different tenant key (with a large cap) so we don't touch the
    // tenant under test. globalCap=10, we already used 2 above → drain 8 more.
    const drainTenantKey = `${tenantKey}-drainer`;
    for (let i = 0; i < 8; i++) {
      const drained = await tryAcquireLlmTokens(redis, {
        ...tenantOpts,
        tenantKey: drainTenantKey,
        tenantCap: 100, // big so the drainer doesn't tenant-deny first
        nowMs: 0,
      });
      expect(drained.allowed).toBe(true);
    }

    // At t=2000ms, attempt acquire on the original tenant. Tenant has 3 + 2s
    // refill = 5 tokens available (capped), so tenant-refill would set
    // ts=2000 and tokens=4 (after debit). The global bucket is empty →
    // global-deny → refund must restore tenant to ts=0 (prior_ts) and
    // tokens=5 (refunded).
    const denied = await tryAcquireLlmTokens(redis, {
      ...tenantOpts,
      nowMs: 2000,
    });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.scope).toBe('global');
    }

    // Verify the tenant's ts was restored to the pre-refill value (0), not
    // 2000. This is the load-bearing assertion for I1 — without it, the
    // next refill would credit the [0, 2000] interval a second time on top
    // of the refunded tokens.
    const tenantTsAfterRefund = Number(await redis.hget(tenantKey, 'ts'));
    expect(tenantTsAfterRefund).toBe(0);

    // Tokens after refund: refill() saw 3 tokens at ts=0, advanced to t=2000,
    // refilled to min(5, 3 + 2*1) = 5, debited 1 → wrote t=4, ts=2000.
    // Then global-deny refund: HINCRBYFLOAT +1 → t=5, HSET ts=0.
    const tenantTokensAfterRefund = Number(
      await redis.hget(tenantKey, 't'),
    );
    expect(tenantTokensAfterRefund).toBe(5);

    // Restore the global bucket so the next acquire succeeds, then verify
    // the tenant doesn't double-credit on the subsequent refill.
    await redis.del(globalKey);

    // At t=3000ms, tenant refills from restored ts=0 → min(5, 5 + 3*1) = 5,
    // then debits 1 → tenantRemaining = 4. If the refund had left ts=2000
    // (the bug), refill would compute 5 + 1*1 = 6 saturated to 5 → same end
    // result by accident at cap. The real proof is at the BUCKET STATE: ts
    // must read 0, not 2000.
    const final = await tryAcquireLlmTokens(redis, {
      ...tenantOpts,
      nowMs: 3000,
    });
    expect(final.allowed).toBe(true);
    if (final.allowed && !final.failedOpen) {
      // Cap-respecting: 0 <= tenantRemaining <= cap - 1.
      expect(final.tenantRemaining).toBeLessThanOrEqual(tenantOpts.tenantCap - 1);
      expect(final.tenantRemaining).toBeGreaterThanOrEqual(0);
    }

    // Cleanup
    await redis.del(drainTenantKey);
  });

  it('allowed path returns sensible tenantRemaining and globalRemaining', async () => {
    const opts = {
      tenantKey,
      tenantCap: 10,
      tenantRefillPerSec: 0,
      globalKey,
      globalCap: 20,
      globalRefillPerSec: 0,
    };
    const r1 = await tryAcquireLlmTokens(redis, opts);
    expect(r1.allowed).toBe(true);
    if (r1.allowed && !r1.failedOpen) {
      expect(r1.tenantRemaining).toBe(9);
      expect(r1.globalRemaining).toBe(19);
    }
    const r2 = await tryAcquireLlmTokens(redis, opts);
    expect(r2.allowed).toBe(true);
    if (r2.allowed && !r2.failedOpen) {
      expect(r2.tenantRemaining).toBe(8);
      expect(r2.globalRemaining).toBe(18);
    }
  });

  it('refuses immediately when tenantCap <= 0 (defensive guard)', async () => {
    const r = await tryAcquireLlmTokens(redis, {
      tenantKey,
      tenantCap: 0,
      tenantRefillPerSec: 1,
      globalKey,
      globalCap: 100,
      globalRefillPerSec: 1,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.scope).toBe('tenant');
      expect(r.retryMs).toBe(0);
    }
    // Neither bucket key should exist — the guard returned before any
    // HMSET / HMGET could create them.
    const tenantExists = await redis.exists(tenantKey);
    expect(tenantExists).toBe(0);
  });

  it('refuses immediately when globalCap <= 0 (defensive guard)', async () => {
    const r = await tryAcquireLlmTokens(redis, {
      tenantKey,
      tenantCap: 100,
      tenantRefillPerSec: 1,
      globalKey,
      globalCap: 0,
      globalRefillPerSec: 1,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.scope).toBe('global');
      expect(r.retryMs).toBe(0);
    }
  });

  it('returns config scope when cost > tenantCap (unreachable retry)', async () => {
    const r = await tryAcquireLlmTokens(redis, {
      tenantKey,
      tenantCap: 5,
      tenantRefillPerSec: 1,
      globalKey,
      globalCap: 1000,
      globalRefillPerSec: 100,
      cost: 10, // > tenantCap
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.scope).toBe('config');
      expect(r.retryMs).toBe(0);
    }
    // Defensive no-write contract: the `cost > cap` guard returns before any
    // HMSET/HMGET, so neither bucket key should have been created.
    expect(await redis.exists(tenantKey)).toBe(0);
    expect(await redis.exists(globalKey)).toBe(0);
  });

  it('refills tokens over time (float-rate arithmetic)', async () => {
    const opts = {
      tenantKey,
      tenantCap: 2,
      tenantRefillPerSec: 10, // fast — 1 token per 100ms
      globalKey,
      globalCap: 1000,
      globalRefillPerSec: 100,
    };
    // Drain the tenant bucket.
    const r1 = await tryAcquireLlmTokens(redis, { ...opts, nowMs: 1_000_000 });
    const r2 = await tryAcquireLlmTokens(redis, { ...opts, nowMs: 1_000_000 });
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    // 3rd call at the same instant should fail (tenant empty).
    const r3 = await tryAcquireLlmTokens(redis, { ...opts, nowMs: 1_000_000 });
    expect(r3.allowed).toBe(false);

    // 500ms later → 5 tokens regenerated, capped at 2.
    const r4 = await tryAcquireLlmTokens(redis, { ...opts, nowMs: 1_000_500 });
    expect(r4.allowed).toBe(true);
  });

  it('sets a TTL so abandoned buckets do not pollute Redis forever', async () => {
    await tryAcquireLlmTokens(redis, {
      tenantKey,
      tenantCap: 5,
      tenantRefillPerSec: 1,
      globalKey,
      globalCap: 100,
      globalRefillPerSec: 10,
    });
    const tenantTtl = await redis.ttl(tenantKey);
    const globalTtl = await redis.ttl(globalKey);
    expect(tenantTtl).toBeGreaterThan(0);
    expect(tenantTtl).toBeLessThanOrEqual(3600);
    expect(globalTtl).toBeGreaterThan(0);
    expect(globalTtl).toBeLessThanOrEqual(3600);
  });
});
