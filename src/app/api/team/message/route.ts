import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  teams,
  teamMembers,
  teamRuns,
  teamMessages,
} from '@/lib/db/schema';
import { getPubSubPublisher } from '@/lib/redis';
import { teamInjectChannel, teamMessagesChannel } from '@/tools/SendMessageTool';
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:team:message');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const requestSchema = z.object({
  teamId: z.string().min(1),
  memberId: z.string().optional(),
  message: z.string().min(1).max(8000),
});

/**
 * POST /api/team/message
 *
 * Body: { teamId, memberId?, message }
 *
 * A user-initiated message to the team.
 *
 *   - When `memberId` is present, the message is targeted at that member.
 *   - When absent, the message is broadcast / goes to the coordinator.
 *
 * If no team_run is currently active, we trigger a new run with `message` as
 * the goal (the coordinator reads it on the first turn).
 *
 * When a run IS active, we (a) record+publish the message to the SSE
 * channel so the UI echoes it immediately, and (b) publish to the
 * per-run inject channel so the worker's coordinator picks it up on its
 * next turn (Phase D Day 3). Messages arriving mid-turn queue server-
 * side and drain at the next turn boundary — we never abort an in-
 * flight API call.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'parse error' },
      { status: 400 },
    );
  }

  const teamRow = await db
    .select({ id: teams.id, userId: teams.userId })
    .from(teams)
    .where(eq(teams.id, body.teamId))
    .limit(1);

  if (teamRow.length === 0 || teamRow[0].userId !== userId) {
    return NextResponse.json({ error: 'team_not_found' }, { status: 404 });
  }

  // Verify target member (if any) belongs to the team.
  let toMemberId: string | null = null;
  if (body.memberId) {
    const members = await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.id, body.memberId),
          eq(teamMembers.teamId, body.teamId),
        ),
      )
      .limit(1);
    if (members.length === 0) {
      return NextResponse.json({ error: 'member_not_found' }, { status: 400 });
    }
    toMemberId = members[0].id;
  }

  // Is there an active run? If so, attach the message to it; if not,
  // trigger a new run (the message becomes the goal).
  const activeRows = await db
    .select({ id: teamRuns.id })
    .from(teamRuns)
    .where(and(eq(teamRuns.teamId, body.teamId), eq(teamRuns.status, 'running')))
    .limit(1);

  const activeRunId = activeRows[0]?.id ?? null;
  const messageId = crypto.randomUUID();
  const createdAt = new Date();

  await db.insert(teamMessages).values({
    id: messageId,
    runId: activeRunId,
    teamId: body.teamId,
    fromMemberId: null, // user
    toMemberId,
    type: 'user_prompt',
    content: body.message,
    metadata: null,
    createdAt,
  });

  try {
    await getPubSubPublisher().publish(
      teamMessagesChannel(body.teamId),
      JSON.stringify({
        messageId,
        runId: activeRunId,
        teamId: body.teamId,
        from: null,
        to: toMemberId,
        type: 'user_prompt',
        content: body.message,
        createdAt: createdAt.toISOString(),
      }),
    );
  } catch (err) {
    log.warn(
      `Redis publish failed for team ${body.teamId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Live injection: when a run is active, push the message onto the
  // worker's per-run inject channel. The coordinator's runAgent drains
  // its FIFO at the next turn boundary and appends the message as a
  // user-role turn. Best-effort — a Redis failure is logged; the
  // durable DB insert above remains the source of truth.
  if (activeRunId) {
    try {
      await getPubSubPublisher().publish(
        teamInjectChannel(body.teamId, activeRunId),
        JSON.stringify({ messageId, content: body.message }),
      );
    } catch (err) {
      log.warn(
        `Inject publish failed for run ${activeRunId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // No active run? Start one with the message as the goal.
  if (!activeRunId) {
    const coordinators = await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, body.teamId),
          eq(teamMembers.agentType, 'coordinator'),
        ),
      )
      .limit(1);

    const rootMemberId = coordinators[0]?.id ?? toMemberId;
    if (!rootMemberId) {
      return NextResponse.json(
        {
          messageId,
          runId: null,
          note: 'Message recorded but no coordinator and no explicit member — no run triggered.',
        },
        { status: 200 },
      );
    }

    const { runId, traceId, alreadyRunning } = await enqueueTeamRun({
      teamId: body.teamId,
      trigger: 'manual',
      goal: body.message,
      rootMemberId,
    });
    return NextResponse.json(
      { messageId, runId, traceId, alreadyRunning },
      { status: 202 },
    );
  }

  return NextResponse.json(
    {
      messageId,
      runId: activeRunId,
      note: 'Message recorded on active run; injected into coordinator on its next turn.',
    },
    { status: 200 },
  );
}
