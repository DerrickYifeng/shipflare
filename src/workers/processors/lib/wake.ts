// Single enqueue point for waking an agent_runs row.
//
// Used by:
//   - Task tool async branch (Phase B) — first spawn (standard lane)
//   - SendMessage tool body (Phase C) — wake on incoming message
//     (standard for peer DMs / shutdown requests)
//   - Sleep tool body (Phase D) — schedule resume (standard lane)
//   - Founder-facing routes (POST /api/team/run, conversation messages,
//     cancel) — priority lane
//   - reconcile-mailbox cron — backfill lane
//
// Dedupe: BullMQ's jobId mechanism collapses duplicate wakes within the
// queue's removeOnComplete window. We use a per-second time bucket so
// near-simultaneous SendMessages don't fire two parallel runAgent loops
// for the same agent. Dedupe is per-LANE — see `enqueueAgentRun` docs.

import {
  enqueueAgentRun,
  type AgentRunPriority,
} from '@/lib/queue/agent-run';

/**
 * Wake the agent identified by `agentId` — schedule its `agent-run`
 * BullMQ job on the requested priority lane. Idempotent within a
 * 1-second window via jobId dedupe.
 *
 * `priority` defaults to `'standard'` — the lane most internal callers
 * (teammate spawns, peer DMs, Sleep resume, TaskStop) belong on.
 * Founder-originated wakes (POST /api/team/run, conversation messages,
 * cancel routes) MUST pass `'priority'`. Cron-triggered backstops
 * (reconcile-mailbox, daily-run fan-out, weekly-replan) MUST pass
 * `'backfill'`.
 *
 * Returns nothing; failures are swallowed and logged. The
 * `reconcile-mailbox` cron (Phase B Task 13) is the durable backstop:
 * it re-enqueues any agent with undelivered mail every minute.
 */
export async function wake(
  agentId: string,
  priority: AgentRunPriority = 'standard',
): Promise<void> {
  // Bucket by seconds so two wakes within the same 1-second window
  // collapse into one BullMQ job. Different seconds → separate runs.
  const bucket = Math.floor(Date.now() / 1000);
  const jobId = `wake:${agentId}:${bucket}`;
  await enqueueAgentRun({ agentId }, { jobId, priority });
}
