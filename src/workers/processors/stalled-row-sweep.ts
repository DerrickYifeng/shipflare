import type { Job } from 'bullmq';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '@/lib/db';
import { threads } from '@/lib/db/schema';
import { xContentCalendar } from '@/lib/db/schema';
import { publishUserEvent } from '@/lib/redis';
import { createLogger, loggerForJob } from '@/lib/logger';

const baseLog = createLogger('worker:stalled-row-sweep');

/**
 * How long a row may stay in `state='drafting'` before we consider the worker
 * crashed. BullMQ lock duration is 5 min; 10 min is a safe "definitely gone"
 * window that still flips the UI well before the next manual retry.
 */
const STALL_THRESHOLD_MS = 10 * 60 * 1000;

const FAILURE_REASON = 'drafting_timeout';

/**
 * Periodic sweep that flips any row stuck in `state='drafting'` for more than
 * the stall threshold to `state='failed'` with a `failureReason` of
 * `drafting_timeout`. Handles both `x_content_calendar` (plan pipeline) and
 * `threads` (reply pipeline). Each flipped row fans out a unified
 * `{type:'pipeline', ..., state:'failed'}` SSE on the appropriate channel so
 * the frontend chip flips immediately without waiting for a refresh.
 *
 * The partial indexes `xcc_state_last_attempt_idx` /
 * `threads_state_last_attempt_idx` (both filtered `WHERE state IN ('drafting',
 * 'failed')`) keep the planner cheap — the scan never touches ready/queued
 * rows.
 *
 * `RETURNING` is used on both UPDATEs so the SELECT + UPDATE happen atomically
 * and we don't miss / double-flip a row under concurrent retries.
 */
export async function processStalledRowSweep(job: Job<Record<string, never>>) {
  const log = loggerForJob(baseLog, job);
  const cutoff = new Date(Date.now() - STALL_THRESHOLD_MS);

  const xccFlipped = await db
    .update(xContentCalendar)
    .set({ state: 'failed', failureReason: FAILURE_REASON })
    .where(
      and(
        eq(xContentCalendar.state, 'drafting'),
        lt(xContentCalendar.lastAttemptAt, cutoff),
      ),
    )
    .returning({
      id: xContentCalendar.id,
      userId: xContentCalendar.userId,
    });

  const threadsFlipped = await db
    .update(threads)
    .set({ state: 'failed', failureReason: FAILURE_REASON })
    .where(and(eq(threads.state, 'drafting'), lt(threads.lastAttemptAt, cutoff)))
    .returning({ id: threads.id, userId: threads.userId });

  for (const row of xccFlipped) {
    await publishUserEvent(row.userId, 'agents', {
      type: 'pipeline',
      pipeline: 'plan',
      itemId: row.id,
      state: 'failed',
      data: { reason: FAILURE_REASON },
    });
  }

  for (const row of threadsFlipped) {
    await publishUserEvent(row.userId, 'drafts', {
      type: 'pipeline',
      pipeline: 'reply',
      itemId: row.id,
      state: 'failed',
      data: { reason: FAILURE_REASON },
    });
  }

  if (xccFlipped.length > 0 || threadsFlipped.length > 0) {
    log.info(
      `stalled-row-sweep: flipped ${xccFlipped.length} plan + ${threadsFlipped.length} reply rows to failed (threshold=${STALL_THRESHOLD_MS / 1000}s)`,
    );
  } else {
    log.debug('stalled-row-sweep: nothing to flip');
  }
}
