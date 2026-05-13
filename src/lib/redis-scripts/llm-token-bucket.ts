import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type IORedis from 'ioredis';
import { createLogger } from '@/lib/logger';

const log = createLogger('redis-scripts:llm-token-bucket');

/**
 * Resolve `llm-token-bucket.lua` next to this module under both Bun and Node.
 * Same approach as `tenant-semaphore.ts`: `import.meta.url` works in both
 * runtimes, sidestepping the missing `__dirname` under native ESM.
 *
 * The script body is read at module load and cached; `defineCommand` ships
 * the source to Redis once per connection.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(here, 'llm-token-bucket.lua'), 'utf8');

const COMMAND_NAME = 'llmTokenBucketAcquire';

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
  redis.defineCommand(COMMAND_NAME, { numberOfKeys: 2, lua: SCRIPT });
}

/**
 * Scope of a denial — which bucket refused the request.
 *
 * - `tenant`: the per-tenant bucket is empty (most common; means this user
 *   is sending too fast for their tier).
 * - `global`: the per-platform-key global bucket is empty (means *all*
 *   tenants combined are exceeding the upstream provider's rate limit).
 * - `config`: a configuration error — typically `cost > cap` — that can
 *   never succeed on retry. Callers should log and surface, not retry.
 */
export type DenyScope = 'tenant' | 'global' | 'config';

/**
 * Result of a token-bucket acquire attempt.
 *
 * Three variants, narrowed via `allowed` and `failedOpen`:
 *
 * 1. `{ allowed: true, tenantRemaining, globalRemaining, failedOpen?: false }`
 *    Happy path — call permitted, Redis updated. Remaining counts are real
 *    and safe to log / surface in `Retry-After`-style headers.
 *
 * 2. `{ allowed: true, failedOpen: true }` — Redis was unreachable; we let
 *    the call through (same trade-off as tenant-semaphore: better to serve
 *    traffic than wedge the worker pool during a Redis outage). Remaining
 *    counts are intentionally absent — we don't know the real values. Track
 *    `failedOpen` separately from real acquires in metrics; a spike means
 *    the limiter is effectively off and the upstream provider's 429s are
 *    the only guardrail.
 *
 * 3. `{ allowed: false, scope, retryMs }` — denied by one of the three
 *    scopes (`tenant` | `global` | `config`). See `DenyScope` for semantics.
 *
 * Narrowing pattern:
 * ```ts
 * const r = await tryAcquireLlmTokens(redis, opts);
 * if (!r.allowed) {
 *   // deny path — r.scope, r.retryMs
 * } else if (r.failedOpen) {
 *   // fail-open — no remaining counts available
 * } else {
 *   // happy path — r.tenantRemaining, r.globalRemaining accessible
 * }
 * ```
 */
export type AcquireLlmResult =
  | {
      allowed: true;
      tenantRemaining: number;
      globalRemaining: number;
      failedOpen?: false;
    }
  | {
      allowed: true;
      failedOpen: true;
    }
  | { allowed: false; scope: DenyScope; retryMs: number };

export interface AcquireLlmTokensOptions {
  /** Per-tenant bucket key, e.g. `llm:tenant:${userId}`. */
  tenantKey: string;
  /** Tenant bucket capacity (max burst). */
  tenantCap: number;
  /**
   * Tenant refill rate in tokens/sec. May be a float
   * (e.g. 1000 RPM → 16.6667/sec; 60 RPM → 1.0/sec).
   * Do NOT `Math.floor` this — pass the float through.
   */
  tenantRefillPerSec: number;
  /** Global bucket key, e.g. `llm:global:anthropic`. */
  globalKey: string;
  /** Global bucket capacity. */
  globalCap: number;
  /** Global refill rate in tokens/sec (float; same units as tenant). */
  globalRefillPerSec: number;
  /**
   * Cost of this acquire in tokens. Defaults to 1 (one request).
   * Pre-flight LLM-token estimation (LiteLLM-class) would pass an estimate
   * here, but that's a deferred follow-up — today we gate on requests.
   */
  cost?: number;
  /**
   * Override the timestamp passed to Lua. Tests use this for determinism;
   * production should let it default to `Date.now()`.
   */
  nowMs?: number;
}

// Lua reply shape:
//   allow: [1, tenantRemaining, globalRemaining]   (numbers)
//   deny:  [0, "tenant"|"global"|"config", retryMs] (string in slot 1)
type LuaReply = [number, number | string, number];

/**
 * Atomically check both the per-tenant and global Anthropic token buckets,
 * consuming one slot in each if both have capacity.
 *
 * Returns `{ allowed: true, ... }` when the call is permitted. When denied,
 * `scope` tells you which bucket refused and `retryMs` is a hint for the
 * earliest time the bucket will refill enough to admit `cost` tokens.
 *
 * Fails OPEN on Redis errors with `failedOpen: true` on the result. The
 * `log.warn` marks the occurrence for ops alerting.
 */
export async function tryAcquireLlmTokens(
  redis: IORedis,
  opts: AcquireLlmTokensOptions,
): Promise<AcquireLlmResult> {
  ensureCommand(redis);
  const cost = opts.cost ?? 1;
  const nowMs = opts.nowMs ?? Date.now();
  try {
    const dyn = redis as unknown as Record<
      string,
      (...args: unknown[]) => Promise<LuaReply>
    >;
    const raw = await dyn[COMMAND_NAME](
      opts.tenantKey,
      opts.globalKey,
      opts.tenantCap,
      opts.tenantRefillPerSec,
      opts.globalCap,
      opts.globalRefillPerSec,
      nowMs,
      cost,
    );
    const flag = Number(raw[0]);
    if (flag === 1) {
      return {
        allowed: true,
        tenantRemaining: Number(raw[1]),
        globalRemaining: Number(raw[2]),
      };
    }
    // Deny path: raw[1] is a scope string, raw[2] is retry_ms.
    const scope = String(raw[1]) as DenyScope;
    return {
      allowed: false,
      scope,
      retryMs: Number(raw[2]),
    };
  } catch (err) {
    log.warn(
      `llm-token-bucket acquire failed for ${opts.tenantKey} / ${opts.globalKey}, failing open: ${err instanceof Error ? err.message : String(err)}`,
    );
    // No remaining counts on the fail-open path — the type union excludes
    // them so callers must narrow on `failedOpen` before logging counts.
    return {
      allowed: true,
      failedOpen: true,
    };
  }
}
