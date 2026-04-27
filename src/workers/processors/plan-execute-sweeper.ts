import type { Job } from 'bullmq';
import { and, eq, inArray, lte, or } from 'drizzle-orm';
import { db } from '@/lib/db';
import { planItems } from '@/lib/db/schema';
import { enqueuePlanExecute } from '@/lib/queue/plan-execute';
import { recordPipelineEventsBulk } from '@/lib/pipeline-events';
import { createLogger, loggerForJob } from '@/lib/logger';
import { nextDispatchPhase } from '@/lib/plan-state';

const log = createLogger('worker:plan-execute-sweeper');

/**
 * How many rows to hand off per cron tick. A burst cap keeps a
 * cold-start backlog from flooding the queue in one minute; the
 * next tick picks up the rest.
 */
const MAX_PER_TICK = 200;

/**
 * Every-minute sweeper. Finds plan_items whose state + userAction
 * combination means they're ready for the next plan-execute phase,
 * AND whose scheduledAt has passed. Enqueues a plan-execute job per
 * row.
 *
 * Two selectable populations:
 *   - state='planned' + userAction IN ('approve','auto') +
 *     scheduledAt <= now — these go to the `draft` (approve) or
 *     `execute` (auto) phase.
 *   - state='approved' — ready to enter `execute` phase. Approved
 *     rows skip the scheduledAt gate because the user explicitly
 *     approved them already; we want the post to go out as soon as
 *     the approval lands.
 *
 * Manual-action rows are NOT swept — the user marks them complete
 * via API directly (Phase 8).
 *
 * The sweeper is idempotent: enqueuePlanExecute dedupes on
 * (planItemId, phase). A re-sweep within the same minute is a
 * no-op at the Redis level.
 */
export async function processPlanExecuteSweeper(
  job: Job<Record<string, never>>,
): Promise<void> {
  const jlog = loggerForJob(log, job);
  const now = new Date();

  // Candidate rows. We pull plan_items that are either (a) planned
  // and due, or (b) approved regardless of scheduledAt. Both paths
  // feed the same enqueue decision; nextDispatchPhase() figures out
  // which phase to request per row.
  const candidates = await db
    .select({
      id: planItems.id,
      userId: planItems.userId,
      state: planItems.state,
      userAction: planItems.userAction,
    })
    .from(planItems)
    .where(
      or(
        and(
          eq(planItems.state, 'planned'),
          inArray(planItems.userAction, ['approve', 'auto']),
          lte(planItems.scheduledAt, now),
        ),
        eq(planItems.state, 'approved'),
      ),
    )
    .limit(MAX_PER_TICK);

  if (candidates.length === 0) {
    jlog.debug('no candidates — tick complete');
    return;
  }

  let enqueued = 0;
  const perUser = new Map<string, number>();
  for (const row of candidates) {
    const phase = nextDispatchPhase(
      row.state,
      row.userAction,
    );
    if (!phase) continue;
    try {
      await enqueuePlanExecute({
        schemaVersion: 1,
        planItemId: row.id,
        userId: row.userId,
        phase,
      });
      enqueued++;
      perUser.set(row.userId, (perUser.get(row.userId) ?? 0) + 1);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      jlog.error(
        `failed to enqueue plan-execute for ${row.id} (phase=${phase}): ${msg}`,
      );
    }
  }

  // Emit a per-user aggregate event so the pipeline_events feed shows
  // whether this cron tick actually produced any enqueues. Swallows
  // insert errors internally — telemetry never breaks the sweep.
  if (perUser.size > 0) {
    await recordPipelineEventsBulk(
      [...perUser.entries()].map(([userId, count]) => ({
        userId,
        stage: 'sweeper_run',
        metadata: { sweeper: 'plan-execute', enqueued: count },
      })),
    );
  }

  jlog.info(
    `swept ${candidates.length} candidates, enqueued ${enqueued} plan-execute jobs across ${perUser.size} users`,
  );
}
