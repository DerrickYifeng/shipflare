// Single enqueue point for waking an agent_runs row.
//
// Used by:
//   - Task tool async branch (Phase B) — first spawn
//   - SendMessage tool body (Phase C) — wake on incoming message
//   - Sleep tool body (Phase D) — schedule resume via BullMQ delay
//
// Dedupe: BullMQ's jobId mechanism collapses duplicate wakes within the
// queue's removeOnComplete window. We use a per-second time bucket so
// near-simultaneous SendMessages don't fire two parallel runAgent loops
// for the same agent.

import { enqueueAgentRun } from '@/lib/queue/agent-run';

/**
 * Wake the agent identified by `agentId` — schedule its `agent-run`
 * BullMQ job. Idempotent within a 1-second window via jobId dedupe.
 *
 * Returns nothing; failures are swallowed and logged. The
 * `reconcile-mailbox` cron (Phase B Task 13) is the durable backstop:
 * it re-enqueues any agent with undelivered mail every minute.
 */
export async function wake(agentId: string): Promise<void> {
  // Bucket by seconds so two wakes within the same 1-second window
  // collapse into one BullMQ job. Different seconds → separate runs.
  const bucket = Math.floor(Date.now() / 1000);
  const jobId = `wake:${agentId}:${bucket}`;
  await enqueueAgentRun({ agentId }, { jobId });
}
