import { getKeyValueClient } from '@/lib/redis';

/**
 * Co-operative "stop requested" signal for long-running automation loops.
 *
 * The war-room Stop button `POST /api/automation/stop` sets a short-lived
 * Redis key that workers can poll between iterations / before enqueuing the
 * next fan-out. Workers already running a single agent step are NOT
 * interrupted mid-flight — stopping is best-effort between safe points.
 *
 * The key auto-expires via TTL so a forgotten flag doesn't silently block
 * future runs.
 */

const STOP_TTL_SECONDS = 60 * 10; // 10 minutes — long enough for any one run

function stopKey(userId: string): string {
  return `automation:stop:${userId}`;
}

/**
 * Flag the user's automation as "please stop".
 *
 * Idempotent — repeated calls just refresh the TTL. Resolves once the key
 * is written so the caller can publish its SSE event afterwards knowing
 * subsequent worker poll-checks will see the flag.
 */
export async function requestStop(userId: string): Promise<void> {
  const kv = getKeyValueClient();
  await kv.set(stopKey(userId), '1', 'EX', STOP_TTL_SECONDS);
}

/**
 * Poll-check: has the user asked us to stop?
 *
 * Call this between iterations of any long-running worker loop (discovery
 * fan-out, calibration rounds, etc.). Cheap: a single `GET` against the
 * shared KV connection.
 */
export async function isStopRequested(userId: string): Promise<boolean> {
  const kv = getKeyValueClient();
  const value = await kv.get(stopKey(userId));
  return value !== null;
}

/**
 * Clear the stop flag — call once a worker acknowledges the stop and has
 * actually unwound, or before kicking off a fresh run (so a stale flag from
 * a prior session doesn't abort the first iteration).
 */
export async function clearStop(userId: string): Promise<void> {
  const kv = getKeyValueClient();
  await kv.del(stopKey(userId));
}
