import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { strategicPaths, users } from '@/lib/db/schema';
import { getKeyValueClient } from '@/lib/redis';
import { runTacticalReplan } from '@/lib/re-plan';
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
 * path, run the tactical planner for the coming week and persist the
 * new plan_items row. Idempotent via per-(user, week) Redis lock.
 *
 * Shares `runTacticalReplan()` with POST /api/plan/replan — one
 * planner invocation, identical supersede+insert transaction, differs
 * only in the `plans.trigger` column value ('weekly' here, 'manual'
 * for the API).
 *
 * Individual user failures are logged and do not abort the batch.
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

  let ran = 0;
  let lockSkipped = 0;
  let failed = 0;
  let totalInserted = 0;
  let totalSuperseded = 0;

  for (const p of activePaths) {
    const acquired = await acquireLock(p.userId, wkKey);
    if (!acquired) {
      lockSkipped++;
      jlog.info(
        `skip replan user=${p.userId} week=${wkKey}: lock already held`,
      );
      continue;
    }

    try {
      const result = await runTacticalReplan(p.userId, 'weekly');
      if (!result.ok) {
        failed++;
        jlog.warn(
          `weekly replan soft-failed user=${p.userId} code=${result.code} detail=${result.detail ?? 'none'}`,
        );
        continue;
      }
      ran++;
      totalInserted += result.itemsInserted;
      totalSuperseded += result.itemsSuperseded;
      jlog.info(
        `weekly replan user=${p.userId} inserted=${result.itemsInserted} superseded=${result.itemsSuperseded}`,
      );
    } catch (err) {
      // Don't let one user's bad data abort the cron. Log and move on.
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      jlog.error(`weekly replan crashed user=${p.userId}: ${message}`);
    }
  }

  jlog.info(
    `weekly replan complete: ran=${ran} failed=${failed} lockSkipped=${lockSkipped} inserted=${totalInserted} superseded=${totalSuperseded}`,
  );
}

// Exported for unit tests
export { weekKey as _weekKeyForTest };
