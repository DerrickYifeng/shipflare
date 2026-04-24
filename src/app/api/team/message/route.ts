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
import { teamInjectChannel, teamMessagesChannel } from '@/tools/SendMessageTool/SendMessageTool';
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
  // enqueue a new run FIRST so the user_prompt can be inserted with the
  // new runId (instead of landing as an orphan with runId=null and then
  // being rejoined by the worker's responses under a different run).
  const activeRows = await db
    .select({ id: teamRuns.id })
    .from(teamRuns)
    .where(and(eq(teamRuns.teamId, body.teamId), eq(teamRuns.status, 'running')))
    .limit(1);

  const preExistingActiveRunId = activeRows[0]?.id ?? null;

  let runIdForMessage: string | null = preExistingActiveRunId;
  let enqueuedRun: {
    runId: string;
    traceId: string;
    alreadyRunning: boolean;
  } | null = null;

  if (!preExistingActiveRunId) {
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
    if (rootMemberId) {
      enqueuedRun = await enqueueTeamRun({
        teamId: body.teamId,
        trigger: 'manual',
        goal: body.message,
        rootMemberId,
      });
      runIdForMessage = enqueuedRun.runId;
    }
    // If no coordinator and no explicit member, `runIdForMessage` stays
    // null — we still record the message below so it's not lost, but no
    // run will process it.
  }

  const messageId = crypto.randomUUID();
  const createdAt = new Date();

  await db.insert(teamMessages).values({
    id: messageId,
    runId: runIdForMessage,
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
        runId: runIdForMessage,
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

  // Live injection: only for runs that were ALREADY running when we
  // checked above. A freshly-enqueued run hasn't spun up its worker loop
  // yet, so the coordinator reads the goal from team_runs.goal on its
  // first turn — nothing to inject.
  if (preExistingActiveRunId) {
    try {
      await getPubSubPublisher().publish(
        teamInjectChannel(body.teamId, preExistingActiveRunId),
        JSON.stringify({ messageId, content: body.message }),
      );
    } catch (err) {
      log.warn(
        `Inject publish failed for run ${preExistingActiveRunId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (enqueuedRun) {
    return NextResponse.json(
      {
        messageId,
        runId: enqueuedRun.runId,
        traceId: enqueuedRun.traceId,
        alreadyRunning: enqueuedRun.alreadyRunning,
      },
      { status: 202 },
    );
  }

  if (!runIdForMessage) {
    return NextResponse.json(
      {
        messageId,
        runId: null,
        note: 'Message recorded but no coordinator and no explicit member — no run triggered.',
      },
      { status: 200 },
    );
  }

  return NextResponse.json(
    {
      messageId,
      runId: runIdForMessage,
      note: 'Message recorded on active run; injected into coordinator on its next turn.',
    },
    { status: 200 },
  );
}
