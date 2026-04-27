import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  teams,
  teamRuns,
  teamTasks,
  teamMembers,
  teamConversations,
} from '@/lib/db/schema';
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:team:task:retry');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/team/task/[taskId]/retry
 *
 * Re-run a failed or cancelled subtask as a fresh independent
 * team_run. The retry doesn't graft back into the original parent's
 * conversation — we spawn a new run seeded with the same subagent +
 * prompt. The new run shows up in the session list; callers can jump
 * there via the returned `runId`.
 *
 * We intentionally avoid live-spawning into the parent run: the
 * parent's runAgent loop may already have terminated (stop_reason),
 * and injecting a new tool_use mid-flight would race with its message
 * state. A clean independent run is simpler and ships the retry
 * intent without cross-run state machinery.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;
  const { taskId } = await params;

  const rows = await db
    .select({
      taskId: teamTasks.id,
      runId: teamTasks.runId,
      teamId: teams.id,
      prompt: teamTasks.prompt,
      description: teamTasks.description,
      input: teamTasks.input,
      taskStatus: teamTasks.status,
      parentConversationId: teamRuns.conversationId,
    })
    .from(teamTasks)
    .innerJoin(teamRuns, eq(teamRuns.id, teamTasks.runId))
    .innerJoin(teams, eq(teams.id, teamRuns.teamId))
    .where(and(eq(teamTasks.id, taskId), eq(teams.userId, userId)))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: 'task_not_found' }, { status: 404 });
  }
  const task = rows[0];

  // Retry only makes sense on terminal failure-paths. Guard the other
  // states so the button on the card can't accidentally triple-fire
  // on a still-running or already-queued task.
  if (
    task.taskStatus !== 'failed' &&
    task.taskStatus !== 'cancelled' &&
    task.taskStatus !== 'completed'
  ) {
    return NextResponse.json(
      { error: 'not_retryable', currentStatus: task.taskStatus },
      { status: 409 },
    );
  }

  // Resolve which specialist to spawn the retry as. The Task input
  // carries `subagent_type` — we map that to the team_members row with
  // the matching agent_type. If the team doesn't have one (e.g., the
  // original task was run by a coordinator-direct tool), fall back to
  // the coordinator so the retry still has a valid rootMemberId.
  const inputObj =
    task.input && typeof task.input === 'object' && !Array.isArray(task.input)
      ? (task.input as Record<string, unknown>)
      : null;
  const subagentType =
    typeof inputObj?.['subagent_type'] === 'string'
      ? (inputObj['subagent_type'] as string)
      : null;

  const members = await db
    .select({ id: teamMembers.id, agentType: teamMembers.agentType })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, task.teamId));

  const byAgentType = new Map(members.map((m) => [m.agentType, m.id]));
  const rootMemberId =
    (subagentType ? byAgentType.get(subagentType) : null) ??
    byAgentType.get('coordinator') ??
    members[0]?.id ??
    null;

  if (!rootMemberId) {
    return NextResponse.json(
      { error: 'no_root_member_available' },
      { status: 400 },
    );
  }

  const goal =
    task.prompt ||
    task.description ||
    `Retry subtask ${task.taskId.slice(0, 8)}`;

  // Chat refactor: the retry attaches to the same conversation the
  // parent run belonged to. If for some reason the parent has no
  // conversation (shouldn't happen post-migration), mint a fresh one
  // so the retry still has a valid home.
  let conversationId: string | null = task.parentConversationId ?? null;
  if (!conversationId) {
    const [created] = await db
      .insert(teamConversations)
      .values({ teamId: task.teamId, title: `Retry of ${task.taskId.slice(0, 8)}` })
      .returning({ id: teamConversations.id });
    conversationId = created!.id;
  }

  const { runId, traceId, alreadyRunning } = await enqueueTeamRun({
    teamId: task.teamId,
    trigger: 'manual',
    goal,
    rootMemberId,
    conversationId,
  });

  log.info(
    `POST /api/team/task/${task.taskId}/retry user=${userId} → new runId=${runId} already=${alreadyRunning}`,
  );

  return NextResponse.json(
    { taskId: task.taskId, runId, traceId, alreadyRunning, conversationId },
    { status: alreadyRunning ? 200 : 202 },
  );
}
