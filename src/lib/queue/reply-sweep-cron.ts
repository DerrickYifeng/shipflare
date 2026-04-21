// Reply-sweep cron queue + schedule helper. The queue carries a
// singleton fan-out job that walks teams and calls the idempotent
// `maybeEnqueueReplySweep(userId)` helper for each. See
// `src/workers/processors/reply-sweep-cron.ts` for the processor.
//
// Cadence is every 6h per spec §4.2 ("Reply-guy sweep | reply_sweep |
// every 6h per user"). The processor is the fan-out; individual
// reply_sweep team_runs are enqueued by `maybeEnqueueReplySweep`.

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
 * Register the 6h repeating fan-out job. Idempotent — BullMQ's repeat
 * jobId de-dupes, so calling this multiple times (e.g. during dev
 * restart) doesn't pile up schedules.
 */
export async function scheduleReplySweepCron(): Promise<void> {
  await replySweepCronQueue.add(
    'fanout',
    {},
    {
      repeat: { every: 6 * 60 * 60 * 1000 }, // 6h
      jobId: 'reply-sweep-cron-repeat',
    },
  );
  log.info('scheduleReplySweepCron: 6h repeat registered');
}
