// Phase B Task 7 — BullMQ queue handle + enqueue helper for agent-runs.
//
// One agent-run job per wake; the worker drains the agent's mailbox,
// processes pending tool calls, and decides whether to sleep again.
//
// B6 — priority lanes:
// We split the single `agent-run` queue into three lanes sharing the
// same `processAgentRun` worker body so a teammate-spawn burst can't sit
// ahead of a fresh founder message. Stripe's critical/non-critical
// pattern:
//   - 'priority'  → founder → lead messages, founder-initiated cancels
//   - 'standard'  → teammate spawns, peer DMs, Sleep resume, TaskStop,
//                   task-notification wakes (the default lane)
//   - 'backfill'  → cron-triggered (daily-run, weekly-replan,
//                   reconcile-mailbox, phase transitions ride on the
//                   cron tier when not founder-initiated)
//
// The per-tenant semaphore from B3 still caps in-flight across all
// three lanes; lanes only decide *order*, not concurrency budget.
//
// Migration note: the STANDARD lane keeps the legacy 'agent-run' queue
// name so in-flight jobs from before the split are picked up by the new
// standard worker on deploy. DO NOT rename to 'agent-run-standard' —
// jobs queued under the old name would orphan in Redis. The priority
// and backfill lanes use fresh names.
//
// Dedupe: callers (notably `wake()` in src/workers/processors/lib/wake.ts)
// pass a deterministic `jobId` so near-simultaneous wakes for the same
// agent collapse into a single BullMQ job within the queue's
// removeOnComplete window. `enqueueAgentRun` defaults `jobId` to
// `data.agentId` so two enqueues with no opts also dedupe. Note: jobId
// dedupe is PER-LANE; a wake fired on 'priority' and another on
// 'standard' for the same agent in the same second produce two jobs.
// That's acceptable because the worker bodies are idempotent (drain →
// fork → persist) and the second job no-ops if the agent is already
// running.
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
// Queues — three lanes, one processor body
// ---------------------------------------------------------------------------

export type AgentRunPriority = 'priority' | 'standard' | 'backfill';

/**
 * BullMQ queue names per lane. The STANDARD lane keeps the legacy
 * 'agent-run' name so existing in-flight jobs drain on deploy without
 * orphaning. New code should use `AGENT_RUN_QUEUE_NAMES[priority]`
 * rather than hardcoding the names.
 */
export const AGENT_RUN_QUEUE_NAMES: Record<AgentRunPriority, string> = {
  priority: 'agent-run-priority',
  standard: 'agent-run', // KEEP legacy name — drain compat on deploy
  backfill: 'agent-run-backfill',
};

/**
 * Legacy export — pointed at the standard lane's queue name. Kept so
 * callers that imported `AGENT_RUN_QUEUE_NAME` before B6 still compile
 * and resolve to the same Redis queue (the standard lane = 'agent-run').
 */
export const AGENT_RUN_QUEUE_NAME = AGENT_RUN_QUEUE_NAMES.standard;

export interface AgentRunJobData {
  agentId: string;
}

const queueDefaults = {
  connection: getBullMQConnection(),
  defaultJobOptions: {
    removeOnComplete: { count: 100, age: 3600 },
    removeOnFail: { count: 500, age: 86400 },
    // No automatic BullMQ retries — the reconcile-mailbox cron is the
    // durable backstop for failed wakes (see file header).
    attempts: 1,
  },
} as const;

const queues: Record<AgentRunPriority, Queue<AgentRunJobData>> = {
  priority: new Queue<AgentRunJobData>(
    AGENT_RUN_QUEUE_NAMES.priority,
    queueDefaults,
  ),
  standard: new Queue<AgentRunJobData>(
    AGENT_RUN_QUEUE_NAMES.standard,
    queueDefaults,
  ),
  backfill: new Queue<AgentRunJobData>(
    AGENT_RUN_QUEUE_NAMES.backfill,
    queueDefaults,
  ),
};

/**
 * Legacy export — pointed at the standard lane handle. Tests that
 * .add()'d through `agentRunQueue` keep working and land in the same
 * Redis queue.
 */
export const agentRunQueue = queues.standard;

/**
 * Reverse lookup: given a running job's `job.queueName` (one of the
 * three BullMQ queue names), return its `AgentRunPriority` lane key.
 * Used by `processAgentRun` so backpressure / rate-limit re-enqueues
 * stay on the same lane the original job came from (a 'priority'
 * founder wake stays on 'priority' across re-enqueues; otherwise the
 * lead's reply latency degrades to standard-tier).
 *
 * Falls back to `'standard'` for unknown queue names — the safe default
 * (also matches the legacy 'agent-run' name).
 */
export function laneFromQueueName(queueName: string): AgentRunPriority {
  for (const [lane, name] of Object.entries(AGENT_RUN_QUEUE_NAMES)) {
    if (name === queueName) return lane as AgentRunPriority;
  }
  return 'standard';
}

// ---------------------------------------------------------------------------
// enqueueAgentRun
// ---------------------------------------------------------------------------

export interface EnqueueAgentRunOptions {
  /**
   * BullMQ job id. Used for dedupe — two adds with the same jobId within
   * the queue's lifetime collapse into one job. Defaults to `data.agentId`
   * so a naive caller still gets per-agent dedupe; callers that want
   * time-bucketed dedupe (e.g. `wake()`) pass an explicit jobId.
   *
   * Note: dedupe is per-LANE, not global. Two enqueues to different
   * lanes with the same jobId produce two distinct BullMQ jobs.
   */
  jobId?: string;
  /**
   * Delay (ms) before the job becomes runnable. Used by the Sleep tool
   * (Phase D) to schedule a future resume.
   */
  delay?: number;
  /**
   * Priority lane to enqueue into. Defaults to `'standard'`. See
   * `AgentRunPriority` for the per-lane semantics + the file header
   * for the lane assignment table.
   */
  priority?: AgentRunPriority;
}

export interface EnqueueAgentRunResult {
  id: string | undefined;
  data: AgentRunJobData;
}

/**
 * Enqueue an `agent-run` BullMQ job to wake the given agent. Idempotent
 * within a single lane via `jobId` (defaults to `data.agentId`).
 */
export async function enqueueAgentRun(
  data: AgentRunJobData,
  opts: EnqueueAgentRunOptions = {},
): Promise<EnqueueAgentRunResult> {
  const priority: AgentRunPriority = opts.priority ?? 'standard';
  const queue = queues[priority];
  const jobId = opts.jobId ?? data.agentId;
  const job = await queue.add('run', data, {
    jobId,
    ...(opts.delay !== undefined ? { delay: opts.delay } : {}),
  });
  log.debug(
    `enqueueAgentRun: agentId=${data.agentId} jobId=${jobId} lane=${priority}${opts.delay ? ` delay=${opts.delay}ms` : ''}`,
  );
  return { id: job.id, data };
}

// ---------------------------------------------------------------------------
// reenqueueWithDelay — backpressure helper (Phase B3, lane-aware in B6)
// ---------------------------------------------------------------------------

/**
 * Re-enqueue an agent-run with a small delay + jitter. Used by:
 *   - the per-tenant semaphore (`acquireTenantSlot` refusal path)
 *     in `processAgentRun` to apply Stripe-style backpressure
 *   - the `LlmRateLimitedError` catch (B5) in `processAgentRun` to
 *     wait out a tenant/global Anthropic token-bucket deny
 *
 * `priority` MUST be threaded through from the current job's lane —
 * `laneFromQueueName(job.queueName)` is the canonical source. Defaulting
 * here is for callers that genuinely don't have a lane (none today),
 * not a quietly-fine fallback for processAgentRun: a 'priority' founder
 * message that re-enqueues onto 'standard' loses its place in the
 * priority lane on the next attempt, which is a regression that's hard
 * to detect from logs alone.
 *
 * The `jobId` collapses near-simultaneous re-enqueues for the same
 * agent into a single delayed job — bucket size = 1 second of the
 * scheduled fire time. Two callers backpressuring the same agent in the
 * same second will dedupe; on the next second they'll get distinct
 * bucket ids. Net effect: a tenant constantly at cap cycles ~1 acquire
 * attempt per second per pending agent rather than thrashing the queue.
 *
 * NOTE: the cap is a SOFT limit. A tenant with 50 work items at cap=3
 * keeps ~3 processing + ~47 queued — each queued one wakes every
 * `delayMs + jitter`, briefly fails to acquire, and re-enqueues. That's
 * by design: tenants get queued, not DoS'd.
 */
export async function reenqueueWithDelay(
  agentId: string,
  delayMs: number,
  priority: AgentRunPriority = 'standard',
): Promise<void> {
  const jitter = Math.floor(Math.random() * 500);
  const bucket = Math.floor((Date.now() + delayMs) / 1000);
  await enqueueAgentRun(
    { agentId },
    {
      jobId: `delayed:${agentId}:${bucket}`,
      delay: delayMs + jitter,
      priority,
    },
  );
}
