// Phase E Task 11: shared dispatch helper that replaces enqueueTeamRun for
// lead-rooted callers (cron fan-out, manual triggers, kickoff, replan,
// phase change, conversation messages).
//
// The unified Phase E shape: every external trigger drops a user_prompt
// `team_messages` row addressed to the team's lead agent and wakes that
// agent. The lead's agent-run loop drains its mailbox and dispatches via
// Task() — same code path the founder UI's POST /api/team/run uses.
//
// The legacy result shape (`runId`, `traceId`, `alreadyRunning`) is
// preserved so callers (and their tests) don't need to be rewritten:
//   - `runId`     → inserted message id (used for polling / log correlation)
//   - `traceId`   → leadAgentId (durable id for log lines)
//   - `alreadyRunning` → always false: wake() is idempotent within a
//                        1-second BullMQ jobId window, so we never observe
//                        a duplicate in practice and a race-detection flag
//                        no longer makes sense.
//
// Plan-execute-sweeper / team/task/[taskId]/retry route to non-lead members
// (content-manager, arbitrary subagent_type). Use `spawnMemberAgentRun`
// in `./spawn-member-agent-run.ts` for that case — they cannot share this
// helper because the lead would not know how to handle "Mode: post_batch"
// without a coordinator playbook entry for it.

import { teamMessages } from '@/lib/db/schema';
import type { Database } from '@/lib/db';
import { ensureLeadAgentRun } from './spawn-lead';
import { wake } from '@/workers/processors/lib/wake';
import type { AgentRunPriority } from '@/lib/queue/agent-run';

export interface DispatchLeadInput {
  teamId: string;
  /** Conversation the message + run live in. REQUIRED — pre-resolved by caller. */
  conversationId: string;
  /** Goal text — becomes the lead's first user_prompt. */
  goal: string;
  /** Trigger label — preserved on metadata for observability. */
  trigger: string;
  /**
   * Optional founder-friendly summary persisted into metadata.publicContent.
   * The redactor at the API boundary swaps this into the `content` field
   * when serving the row to the browser. The raw `goal` stays in `content`
   * (worker reads it for agent replay). Use for any goal text that exposes
   * internal architecture details — kickoff playbook, cron-trigger details,
   * routing instructions, etc.
   */
  publicSummary?: string;
  /**
   * B6: wake-lane priority. Defaults to `'standard'` — appropriate for
   * internal callers. Founder-originated dispatches should pass
   * `'priority'`; cron-driven (daily-run, weekly-replan, phase
   * transitions when not founder-initiated) should pass `'backfill'`.
   */
  priority?: AgentRunPriority;
}

export interface DispatchLeadResult {
  /** Inserted team_messages.id — surrogate for legacy team_runs.id. */
  runId: string;
  /** Lead's agent_runs.id — durable trace handle for log lines. */
  traceId: string;
  /**
   * Always false in Phase E. wake() is idempotent within a 1-second
   * BullMQ jobId window so duplicate enqueues collapse silently and
   * race-detection happens at the queue layer.
   */
  alreadyRunning: false;
}

export async function dispatchLeadMessage(
  input: DispatchLeadInput,
  db: Database,
): Promise<DispatchLeadResult> {
  const { agentId: leadAgentId } = await ensureLeadAgentRun(input.teamId, db);

  const messageId = crypto.randomUUID();
  const metadata: Record<string, unknown> = { trigger: input.trigger };
  if (input.publicSummary) {
    metadata.publicContent = input.publicSummary;
  }
  await db.insert(teamMessages).values({
    id: messageId,
    teamId: input.teamId,
    conversationId: input.conversationId,
    fromMemberId: null, // user-originated (cron, founder UI, manual trigger)
    toMemberId: null,
    toAgentId: leadAgentId,
    type: 'user_prompt',
    messageType: 'message',
    content: input.goal,
    contentBlocks: [{ type: 'text', text: input.goal }],
    summary: input.goal.slice(0, 80),
    metadata,
  });

  await wake(leadAgentId, input.priority ?? 'standard');

  return {
    runId: messageId,
    traceId: leadAgentId,
    alreadyRunning: false,
  };
}
