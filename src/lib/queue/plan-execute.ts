import { z } from 'zod';
import { Queue } from 'bullmq';
import { getBullMQConnection } from '@/lib/redis';

const connection = { connection: getBullMQConnection() };

/**
 * plan-execute is the one queue that replaces many. Every `plan_items`
 * row ready for its next state transition (planned+approve, planned+auto,
 * or approved) flows through here.
 *
 * The job payload carries only the row id + phase. The processor
 * re-reads the current row so stale queue entries don't drive out-of-
 * date state — for example if the item was superseded between enqueue
 * and execute.
 *
 * Deduped on `(planItemId, phase)`: double-enqueue from the sweeper
 * collapses to a single job until the first one completes and the
 * id rotates out of Redis.
 */
export const planExecuteJobSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  traceId: z.string().min(1).optional(),
  planItemId: z.string().min(1),
  userId: z.string().min(1),
  phase: z.enum(['draft', 'execute']),
});

export type PlanExecuteJobData = z.input<typeof planExecuteJobSchema>;

const DEFAULT_JOB_OPTIONS = {
  // Drafts + execute steps are both expensive enough (LLM call or
  // outbound post / email) that DLQ-forensics matter. Wider retention
  // than the default queue — 7d failed / 24h completed.
  removeOnComplete: { count: 500, age: 24 * 3600 },
  removeOnFail: { count: 1000, age: 7 * 24 * 3600 },
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
};

export const planExecuteQueue = new Queue<PlanExecuteJobData>(
  'plan-execute',
  {
    ...connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  },
);

/**
 * Enqueue a plan-execute job for one plan_item transition.
 *
 * jobId is `(planItemId, phase)`-scoped — the sweeper + manual
 * approve API may both try to enqueue the same transition; BullMQ
 * drops the second add when a waiting/active/delayed job with the
 * same id exists. Once a job completes its id drops out of Redis so
 * a subsequent draft→execute transition can enqueue cleanly.
 */
export async function enqueuePlanExecute(
  data: PlanExecuteJobData,
): Promise<string> {
  const payload = planExecuteJobSchema.parse(data);
  const jobId = `pe-${payload.planItemId}-${payload.phase}`;
  const job = await planExecuteQueue.add('transition', payload, { jobId });
  return job.id ?? jobId;
}
