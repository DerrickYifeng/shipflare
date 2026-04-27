// Reply-sweep cron queue + schedule helper. The queue carries a
// singleton fan-out job that walks teams and calls the idempotent
// `maybeEnqueueReplySweep(userId)` helper for each. See
// `src/workers/processors/reply-sweep-cron.ts` for the processor.
//
// Cadence: ONCE per day. The cron repeats every 24h; the helper
// throttles per-user to "skip if a reply_sweep already started today
// (UTC date)". The daily session itself runs the discovery + draft
// loop up to 3 inner attempts to hit the slot's targetCount, so
// firing the cron more often than once a day would just collide on
// the in-day throttle.
//
// (Previously every 6h with a "skipped if no recent thread in inbox"
// guard. The new model owns discovery inside the run, so an empty
// inbox at cron-fire time is fine.)

import { Queue } from 'bullmq';
import { z } from 'zod';
import { getBullMQConnection } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:queue:reply-sweep-cron');

export const REPLY_SWEEP_CRON_QUEUE_NAME = 'reply-sweep-cron';

export const replySweepCronJobSchema = z.object({
  /** Reserved for future targeted runs (e.g. a single userId). Unused today. */
  userId: z.string().optional(),
  traceId: z.string().optional(),
});

export type ReplySweepCronJobData = z.infer<typeof replySweepCronJobSchema>;

export const replySweepCronQueue = new Queue<ReplySweepCronJobData>(
  REPLY_SWEEP_CRON_QUEUE_NAME,
  {
    connection: getBullMQConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 24 * 3600 },
      removeOnFail: { count: 200, age: 7 * 24 * 3600 },
      attempts: 1, // fan-out is cheap — no retry
    },
  },
);

/**
 * Register the 24h repeating fan-out job. Idempotent — BullMQ's repeat
 * jobId de-dupes, so calling this multiple times (e.g. during dev
 * restart) doesn't pile up schedules.
 *
 * Migration note: an earlier version of this cron ran every 6h. BullMQ
 * keys repeat schedules off the option hash — a stale 6h repeat with
 * the same name can linger in Redis after a deploy. We clear any
 * pre-existing repeatables for this queue before re-registering, so a
 * deploy from the 6h version transitions cleanly to the 24h cadence.
 */
export async function scheduleReplySweepCron(): Promise<void> {
  // Sweep stale repeatables (e.g. the prior 6h schedule) so the new
  // 24h schedule is the only one alive.
  const existing = await replySweepCronQueue.getRepeatableJobs();
  for (const job of existing) {
    await replySweepCronQueue.removeRepeatableByKey(job.key);
  }

  await replySweepCronQueue.add(
    'fanout',
    {},
    {
      repeat: { every: 24 * 60 * 60 * 1000 }, // 24h
      jobId: 'reply-sweep-cron-repeat',
    },
  );
  log.info('scheduleReplySweepCron: 24h repeat registered');
}
