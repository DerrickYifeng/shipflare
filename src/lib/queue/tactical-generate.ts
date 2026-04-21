import { z } from 'zod';
import { Queue } from 'bullmq';
import { getBullMQConnection } from '@/lib/redis';

const connection = { connection: getBullMQConnection() };

/**
 * tactical-generate runs the tactical-planner asynchronously after
 * `/api/onboarding/commit` has already persisted the product +
 * strategic_paths + header-only plans row. The processor fills in
 * plan_items for the supplied `planId` so /today's progress widget can
 * watch the tactical plan arrive in the background.
 *
 * Payload intentionally carries `planId` rather than inventing a fresh
 * one — the commit route pre-writes the plans row inside its
 * transaction, so the tactical run is strictly an INSERT into
 * plan_items (no new plans row, no supersede pass).
 *
 * Dedup: jobId scoped to `planId` so accidental double-enqueues collapse
 * to one active job.
 */
export const tacticalGenerateJobSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  traceId: z.string().min(1).optional(),
  userId: z.string().min(1),
  productId: z.string().min(1),
  strategicPathId: z.string().min(1),
  planId: z.string().min(1),
});

export type TacticalGenerateJobData = z.input<typeof tacticalGenerateJobSchema>;

const DEFAULT_JOB_OPTIONS = {
  // Plan rows without items appear on /today as "Calibrating your plan…".
  // Retention of 7d on failure + 24h on success matches plan-execute so
  // DLQ forensics have room.
  removeOnComplete: { count: 500, age: 24 * 3600 },
  removeOnFail: { count: 1000, age: 7 * 24 * 3600 },
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
};

export const tacticalGenerateQueue = new Queue<TacticalGenerateJobData>(
  'tactical-generate',
  {
    ...connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  },
);

/**
 * Enqueue a tactical-generate job. Returns the BullMQ job id so the
 * caller (the commit route) can pass it back to the client for
 * progress-widget correlation.
 */
export async function enqueueTacticalGenerate(
  data: TacticalGenerateJobData,
): Promise<string> {
  const payload = tacticalGenerateJobSchema.parse(data);
  const jobId = `tg-${payload.planId}`;
  const job = await tacticalGenerateQueue.add('generate', payload, { jobId });
  return job.id ?? jobId;
}
