import { getKeyValueClient } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:rate-limit');

export interface RateLimitResult {
  /** True = caller is allowed to proceed; false = rate-limited. */
  allowed: boolean;
  /** Seconds until the current limit window resets. 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * Single-bucket rate limiter backed by Redis SET NX EX.
 *
 * Semantics: at most one allowed call per `(key, windowSeconds)` tuple.
 * Callers that pass the same key inside the window get
 * `{ allowed: false, retryAfterSeconds }`.
 *
 * This is the simplest of rate-limiting primitives — a single token per
 * window. Good enough for the planner endpoints where the user pressing
 * "Generate plan" twice within 10s is the failure mode we care about.
 * If we need per-user leaky-bucket later, swap this out for a
 * token-bucket impl.
 *
 * Example:
 *   const rl = await acquireRateLimit(`plan:${userId}`, 10);
 *   if (!rl.allowed) {
 *     return NextResponse.json(
 *       { error: 'rate_limited', retryAfterSeconds: rl.retryAfterSeconds },
 *       { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } },
 *     );
 *   }
 */
export async function acquireRateLimit(
  key: string,
  windowSeconds: number,
): Promise<RateLimitResult> {
  if (windowSeconds <= 0) {
    throw new Error(`acquireRateLimit: windowSeconds must be > 0 (got ${windowSeconds})`);
  }

  const kv = getKeyValueClient();
  const redisKey = `ratelimit:${key}`;

  try {
    const result = await kv.set(redisKey, '1', 'EX', windowSeconds, 'NX');
    if (result === 'OK') {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    // Key already exists — fetch TTL for a useful Retry-After.
    const ttl = await kv.ttl(redisKey);
    return {
      allowed: false,
      retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  } catch (err) {
    // Fail open on Redis errors — better to serve a request than to
    // wedge the API when Redis is flaky. Log loud so we notice.
    log.warn(
      `acquireRateLimit: redis error for key=${redisKey}, failing open: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
