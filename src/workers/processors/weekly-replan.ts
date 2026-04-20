import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { strategicPaths, users } from '@/lib/db/schema';
import { getKeyValueClient } from '@/lib/redis';
import { createLogger, loggerForJob } from '@/lib/logger';

const log = createLogger('worker:weekly-replan');

/**
 * One ISO-week of lock TTL. Guarantees at-most-once per (user, week)
 * even if the cron fires twice due to worker restart / clock jitter.
 */
const REPLAN_LOCK_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Compute the Monday-anchored ISO week key for a date, in UTC. Used
 * to namespace the per-user Redis lock so consecutive weeks don't
 * collide.
 */
function weekKey(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();
  const diff = (day + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

async function acquireLock(
  userId: string,
  wkKey: string,
): Promise<boolean> {
  const kv = getKeyValueClient();
  const key = `replan:${userId}:${wkKey}`;
  const result = await kv.set(key, '1', 'EX', REPLAN_LOCK_TTL_SECONDS, 'NX');
  return result === 'OK';
}

/**
 * Monday 00:00 UTC cron. For every user with an active strategic
 * path, run a tactical replan for the coming week.
 *
 * Phase 7 scope: find candidate users + acquire the per-user lock +
 * log an "enqueued" line. The actual tactical-planner invocation +
 * plan_items insert lands in Phase 8 (which owns the API endpoint
 * POST /api/plan/replan that shares this code path).
 *
 * Idempotent: the Redis lock ensures a double-fire (worker restart,
 * BullMQ cron overlap) collapses to one run per (user, week).
 */
export async function processWeeklyReplan(
  job: Job<Record<string, never>>,
): Promise<void> {
  const jlog = loggerForJob(log, job);
  const now = new Date();
  const wkKey = weekKey(now);

  const activePaths = await db
    .select({
      userId: strategicPaths.userId,
      productId: strategicPaths.productId,
      pathId: strategicPaths.id,
    })
    .from(strategicPaths)
    .innerJoin(users, eq(users.id, strategicPaths.userId))
    .where(eq(strategicPaths.isActive, true));

  jlog.info(
    `weekly replan: ${activePaths.length} users with active strategic paths (week=${wkKey})`,
  );

  let enqueued = 0;
  let lockSkipped = 0;

  for (const p of activePaths) {
    const acquired = await acquireLock(p.userId, wkKey);
    if (!acquired) {
      lockSkipped++;
      jlog.info(
        `skip replan user=${p.userId} week=${wkKey}: lock already held`,
      );
      continue;
    }

    // TODO(phase-8): enqueue tactical-planner for this (userId,
    // productId, strategicPathId, weekStart). For now we log the
    // decision so the cron is verifiable end-to-end without waiting
    // on Phase 8's API.
    jlog.info(
      `weekly replan candidate: user=${p.userId} productId=${p.productId} pathId=${p.pathId} week=${wkKey}`,
    );
    enqueued++;
  }

  jlog.info(
    `weekly replan complete: ${enqueued} candidates processed, ${lockSkipped} already locked`,
  );
}

// Exported for unit tests
export { weekKey as _weekKeyForTest };
// Silence unused-var warning on the and() import — kept for future
// Phase 8 wiring where we filter active + non-churned users together.
void and;
