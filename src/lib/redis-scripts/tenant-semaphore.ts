import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type IORedis from 'ioredis';
import { createLogger } from '@/lib/logger';

const log = createLogger('redis-scripts:tenant-semaphore');

/**
 * Resolve `tenant-semaphore.lua` next to this module under both Bun and Node.
 *
 * - Bun and Node 22 both expose `import.meta.url`; deriving the dir via
 *   `fileURLToPath` works in either runtime without relying on `__dirname`
 *   (which is absent under native ESM).
 * - We read at module load and cache the script body; `defineCommand` ships
 *   the source to Redis once per connection.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(here, 'tenant-semaphore.lua'), 'utf8');

const COMMAND_NAME = 'tenantSemaphoreAcquire';

/**
 * Define the Lua command on this client if not already defined.
 *
 * `defineCommand` attaches a method named `COMMAND_NAME` to the client
 * instance. We probe for that property to keep this call idempotent —
 * cheap on hot paths, defensive against double-registration warnings.
 */
function ensureCommand(redis: IORedis): void {
  // ioredis's dynamic-command typing isn't reflected in its `.d.ts`, so we
  // narrow through `unknown` to access the runtime-defined method.
  const dyn = redis as unknown as Record<string, unknown>;
  if (typeof dyn[COMMAND_NAME] === 'function') return;
  redis.defineCommand(COMMAND_NAME, { numberOfKeys: 1, lua: SCRIPT });
}

export interface AcquireResult {
  /** True iff a slot was reserved by this call. */
  acquired: boolean;
  /** Current in-flight count after the call (regardless of acquire/refuse). */
  current: number;
  /** Cap echoed back from the Lua script (for diagnostics). */
  cap: number;
}

/**
 * Inflight key for a given user. Centralised so future renames are a
 * one-liner. Keep keys colon-delimited and lower-case to match
 * existing conventions (`ratelimit:*` etc.).
 */
function inflightKey(userId: string): string {
  return `inflight:agent:${userId}`;
}

type LuaReply = [number, number, number];

/**
 * Atomically attempt to reserve a per-tenant in-flight slot.
 *
 * Returns `{ acquired: true, ... }` when a slot was reserved; the caller MUST
 * pair it with `releaseTenantSlot` in a finally-block to free the slot when
 * the job completes (or crashes — TTL provides the crash safety net).
 *
 * Fails OPEN on Redis errors. Same rationale as `acquireRateLimit`:
 * better to serve traffic than wedge the worker pool when Redis is flaky.
 * The `log.warn` marks it for ops alerting.
 */
export async function acquireTenantSlot(
  redis: IORedis,
  userId: string,
  cap: number,
  ttlSeconds: number,
): Promise<AcquireResult> {
  ensureCommand(redis);
  const key = inflightKey(userId);
  try {
    const dyn = redis as unknown as Record<
      string,
      (...args: unknown[]) => Promise<LuaReply>
    >;
    const raw = await dyn[COMMAND_NAME](key, cap, ttlSeconds);
    return { acquired: raw[0] === 1, current: raw[1], cap: raw[2] };
  } catch (err) {
    log.warn(
      `tenant-semaphore acquire failed for ${userId}, failing open: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { acquired: true, current: 0, cap };
  }
}

/**
 * Unconditionally decrement the in-flight counter for a tenant.
 *
 * Floors at 0 — a stray release (or a release after Redis dropped the key
 * due to TTL) MUST NOT produce a negative count that would then "consume"
 * subsequent legitimate acquires.
 *
 * Fails silently (with a warn log) on Redis errors. The TTL set by
 * `acquireTenantSlot` is the safety net: even if every release call fails,
 * slots eventually reclaim themselves.
 */
export async function releaseTenantSlot(
  redis: IORedis,
  userId: string,
): Promise<void> {
  const key = inflightKey(userId);
  try {
    const newval = await redis.decr(key);
    if (newval < 0) {
      await redis.set(key, '0');
    }
  } catch (err) {
    log.warn(
      `tenant-semaphore release failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
