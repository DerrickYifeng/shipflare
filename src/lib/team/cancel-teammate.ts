// UI-B Task 11: per-teammate cancel helper.
//
// Inserts a `shutdown_request` row addressed to the target agent_run and
// wakes it. The agent-run loop (Phase C Task 7) drains the request at
// its next idle turn, exits gracefully with status='killed', and
// `publishStatusChange` emits the SSE event the roster listens for —
// which is how the row disappears from the UI without any client-side
// cleanup.
//
// Auth happens at the route layer (`/api/team/agent/[agentId]/cancel`).
// This helper is the I/O leaf and assumes ownership has already been
// verified.
//
// Why a `shutdown_request` and not a hard kill: the loop owns the
// commit + tool-result invariants. A hard SIGKILL on the BullMQ job
// would risk leaving partial tool calls without a matching
// `tool_result`, which then breaks the next conversation replay. The
// graceful path is the only safe path; the trade-off is up to one
// additional turn of latency between click and disappearance.

import { eq } from 'drizzle-orm';
import { agentRuns, teamMessages } from '@/lib/db/schema';
import { wake } from '@/workers/processors/lib/wake';
import type { Database } from '@/lib/db';

/**
 * Schedule a graceful cancel for a single agent_runs row.
 *
 * Inserts a `shutdown_request` row addressed to `agentId` and enqueues
 * a wake. Throws when the target row does not exist — the caller is
 * expected to have already verified ownership and converted "no row"
 * into a 404. We don't 404 here because the helper has no HTTP context.
 */
export async function cancelTeammate(
  agentId: string,
  db: Database,
): Promise<void> {
  // Look up the target so we can stamp `teamId` on the message row
  // (the schema requires it; team_messages.teamId is NOT NULL). We
  // intentionally don't filter by status here — sending shutdown_request
  // to an already-completed agent is a harmless no-op once the loop
  // exits, and gating on status would add a TOCTOU race against the
  // graceful exit path.
  const [target] = await db
    .select({
      teamId: agentRuns.teamId,
      memberId: agentRuns.memberId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, agentId))
    .limit(1);
  if (!target) {
    throw new Error(`agent_runs ${agentId} not found`);
  }

  await db.insert(teamMessages).values({
    teamId: target.teamId,
    type: 'user_prompt',
    messageType: 'shutdown_request',
    fromMemberId: null,
    toMemberId: target.memberId,
    toAgentId: agentId,
    content: 'Cancelled by founder via UI',
    summary: 'cancel',
  });

  // Wake the target so it drains the request promptly. The
  // `reconcile-mailbox` cron is the durable backstop if this fails for
  // any reason.
  await wake(agentId);
}
