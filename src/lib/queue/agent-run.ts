// Phase B Task 7 — BullMQ queue handle + enqueue helper for agent-runs.
//
// One queue per agent-run job; jobs wake an `agents` row (the per-member
// long-running process introduced in Phase B) so it can drain its mailbox,
// process pending tool calls, and decide whether to sleep again.
//
// Dedupe: callers (notably `wake()` in src/workers/processors/lib/wake.ts)
// pass a deterministic `jobId` so near-simultaneous wakes for the same
// agent collapse into a single BullMQ job within the queue's
// removeOnComplete window. `enqueueAgentRun` defaults `jobId` to
// `data.agentId` so two enqueues with no opts also dedupe.
//
// Retries: `attempts: 1` — agent-run jobs are expensive (LLM turns) and
// the durable backstop is the `reconcile-mailbox` cron (Phase B Task 13)
// which re-enqueues any agent with undelivered mail every minute. We do
// NOT want BullMQ silently retrying a failed run mid-conversation.

import { Queue } from 'bullmq';
import { getBullMQConnection } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:queue:agent-run');

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export const AGENT_RUN_QUEUE_NAME = 'agent-run';

export interface AgentRunJobData {
  agentId: string;
}

export const agentRunQueue = new Queue<AgentRunJobData>(AGENT_RUN_QUEUE_NAME, {
  connection: getBullMQConnection(),
  defaultJobOptions: {
    removeOnComplete: { count: 100, age: 3600 },
    removeOnFail: { count: 500, age: 86400 },
    // No automatic BullMQ retries — the reconcile-mailbox cron is the
    // durable backstop for failed wakes (see file header).
    attempts: 1,
  },
});

// ---------------------------------------------------------------------------
// enqueueAgentRun
// ---------------------------------------------------------------------------

export interface EnqueueAgentRunOptions {
  /**
   * BullMQ job id. Used for dedupe — two adds with the same jobId within
   * the queue's lifetime collapse into one job. Defaults to `data.agentId`
   * so a naive caller still gets per-agent dedupe; callers that want
   * time-bucketed dedupe (e.g. `wake()`) pass an explicit jobId.
   */
  jobId?: string;
  /**
   * Delay (ms) before the job becomes runnable. Used by the Sleep tool
   * (Phase D) to schedule a future resume.
   */
  delay?: number;
}

export interface EnqueueAgentRunResult {
  id: string | undefined;
  data: AgentRunJobData;
}

/**
 * Enqueue an `agent-run` BullMQ job to wake the given agent. Idempotent
 * via `jobId` (defaults to `data.agentId`).
 */
export async function enqueueAgentRun(
  data: AgentRunJobData,
  opts: EnqueueAgentRunOptions = {},
): Promise<EnqueueAgentRunResult> {
  const jobId = opts.jobId ?? data.agentId;
  const job = await agentRunQueue.add('run', data, {
    jobId,
    ...(opts.delay !== undefined ? { delay: opts.delay } : {}),
  });
  log.debug(`enqueueAgentRun: agentId=${data.agentId} jobId=${jobId}${opts.delay ? ` delay=${opts.delay}ms` : ''}`);
  return { id: job.id, data };
}
