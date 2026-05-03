import { NextResponse, type NextRequest } from 'next/server';
import { and, eq, inArray, not } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { teams, teamMembers, teamTasks } from '@/lib/db/schema';
import { getPubSubPublisher } from '@/lib/redis';
import { teamMessagesChannel } from '@/tools/SendMessageTool/SendMessageTool';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:team:task:cancel');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/team/task/[taskId]/cancel
 *
 * Soft-cancel a single subtask without touching the parent run. The DB
 * row flips to `status='cancelled'`; any tool_result the subagent
 * eventually emits is harmlessly ignored by the client reducer because
 * its guard skips already-terminal DelegationTasks. We don't plumb a
 * per-spawn AbortController — that'd require wiring each AgentTool
 * spawn to its own Redis cancel channel, and per-task cancel is
 * low-frequency enough that burning a few more tokens is acceptable.
 *
 * Also publishes a synthetic `tool_result` with `metadata.isError=true`
 * + `metadata.cancelled=true` on the team messages channel so the UI
 * flips the subtask card to CANCELLED immediately, without waiting for
 * the next page refetch.
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

  // UI-A Task 4: ownership chain is now teamTasks → teamMembers → teams.
  // Phase E removed teamRuns from the read path; cancel only needs the
  // task row + the owning team. The legacy `teamTasks.runId` value is
  // still echoed in the published SSE payload for client correlation,
  // but is no longer used as a join key.
  const rows = await db
    .select({
      taskId: teamTasks.id,
      runId: teamTasks.runId,
      teamId: teams.id,
      taskStatus: teamTasks.status,
      input: teamTasks.input,
      ownerId: teams.userId,
    })
    .from(teamTasks)
    .innerJoin(teamMembers, eq(teamMembers.id, teamTasks.memberId))
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamTasks.id, taskId), eq(teams.userId, userId)))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: 'task_not_found' }, { status: 404 });
  }
  const task = rows[0];
  if (
    task.taskStatus === 'completed' ||
    task.taskStatus === 'failed' ||
    task.taskStatus === 'cancelled'
  ) {
    return NextResponse.json(
      {
        taskId: task.taskId,
        status: task.taskStatus,
        alreadyTerminal: true,
      },
      { status: 200 },
    );
  }

  try {
    await db
      .update(teamTasks)
      .set({ status: 'cancelled', completedAt: new Date() })
      .where(
        and(
          eq(teamTasks.id, task.taskId),
          not(
            inArray(teamTasks.status, ['completed', 'failed', 'cancelled']),
          ),
        ),
      );
  } catch (err) {
    log.warn(
      `DB cancel update failed for task ${task.taskId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Pull the coord's tool_use_id from the task input so the client's
  // reducer can match this synthetic terminal event to the right
  // DelegationTask via its `toolUseId` field.
  const inputObj =
    task.input && typeof task.input === 'object' && !Array.isArray(task.input)
      ? (task.input as Record<string, unknown>)
      : null;
  const toolUseId =
    typeof inputObj?.['toolUseId'] === 'string'
      ? (inputObj['toolUseId'] as string)
      : null;

  if (toolUseId) {
    try {
      await getPubSubPublisher().publish(
        teamMessagesChannel(task.teamId),
        JSON.stringify({
          messageId: crypto.randomUUID(),
          runId: task.runId,
          teamId: task.teamId,
          from: null,
          to: null,
          type: 'tool_result',
          content: 'Subtask cancelled by user.',
          metadata: {
            toolUseId,
            isError: true,
            cancelled: true,
            initiatedBy: 'user',
          },
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (err) {
      log.warn(
        `SSE cancel broadcast failed for task ${task.taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  log.info(`POST /api/team/task/${task.taskId}/cancel user=${userId}`);
  return NextResponse.json(
    { taskId: task.taskId, status: 'cancelled' },
    { status: 202 },
  );
}
