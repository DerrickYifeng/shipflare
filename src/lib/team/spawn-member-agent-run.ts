// Phase E Task 11: spawn an `agent_runs` row for a non-lead team member
// directly, bypassing the lead. Mirrors the Task tool's
// `launchAsyncTeammate` shape but without the spawning-agent context — the
// caller is a worker (plan-execute-sweeper) or an HTTP route
// (team/task/[taskId]/retry), not another agent.
//
// Use cases:
//   - plan-execute-sweeper claims a batch of `content_post` plan_items and
//     hands them straight to the team's content-manager. Going via the lead
//     would require the coordinator AGENT.md to learn a "Mode: post_batch"
//     playbook just to forward the work — wasteful given there's no
//     planning step left.
//   - team/task/[taskId]/retry restarts a failed subtask as the SAME
//     specialist that originally ran it, using the original prompt verbatim.
//
// For lead-rooted automation triggers (daily cron fanout, kickoff,
// replan, phase change, founder UI message) use `dispatchLeadMessage`
// in `./dispatch-lead-message.ts` instead.

import { agentRuns, teamMembers, teamMessages } from '@/lib/db/schema';
import type { Database } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { wake } from '@/workers/processors/lib/wake';

export interface SpawnMemberInput {
  teamId: string;
  /** team_members.id of the target specialist. */
  memberId: string;
  /** AgentDefinition.name (matches the AGENT.md `name:` frontmatter). */
  agentDefName: string;
  /** Conversation the run lives in. */
  conversationId: string;
  /** Goal text — becomes the spawned agent's first user_prompt. */
  prompt: string;
  /** Short label for observability + UI rendering. */
  description: string;
  /** Trigger label — preserved on metadata for observability. */
  trigger: string;
}

export interface SpawnMemberResult {
  /** New agent_runs.id — durable handle for the spawned specialist. */
  agentId: string;
  /** Inserted user_prompt team_messages.id. */
  messageId: string;
}

export async function spawnMemberAgentRun(
  input: SpawnMemberInput,
  db: Database,
): Promise<SpawnMemberResult> {
  // Defensive: confirm the target member belongs to the supplied team.
  // The callers already do this lookup but we re-check so a misuse can't
  // route work into the wrong team.
  const member = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.id, input.memberId),
        eq(teamMembers.teamId, input.teamId),
      ),
    )
    .limit(1);
  if (member.length === 0) {
    throw new Error(
      `spawnMemberAgentRun: member ${input.memberId} not in team ${input.teamId}`,
    );
  }

  const agentId = crypto.randomUUID();

  // 1. Queue the agent_runs row. parentAgentId=null because the spawner
  //    is an external trigger (cron / HTTP route), not another agent.
  await db.insert(agentRuns).values({
    id: agentId,
    teamId: input.teamId,
    memberId: input.memberId,
    agentDefName: input.agentDefName,
    parentAgentId: null,
    status: 'queued',
  });

  // 2. Initial prompt as the FIRST mailbox message addressed to the new
  //    agentId. The agent-run processor reads it via drainMailbox.
  const messageId = crypto.randomUUID();
  await db.insert(teamMessages).values({
    id: messageId,
    teamId: input.teamId,
    conversationId: input.conversationId,
    fromMemberId: null, // external (cron / HTTP), not another agent
    toAgentId: agentId,
    type: 'user_prompt',
    messageType: 'message',
    content: input.prompt,
    contentBlocks: [{ type: 'text', text: input.prompt }],
    summary: input.description.slice(0, 80),
    metadata: { trigger: input.trigger },
  });

  // 3. Wake the agent-run worker. Idempotent within a 1-second jobId window.
  await wake(agentId);

  return { agentId, messageId };
}
