import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { teams, teamMembers } from '@/lib/db/schema';
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:team:run');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const requestSchema = z.object({
  teamId: z.string().min(1),
  goal: z.string().min(1).max(4000),
  trigger: z
    .enum(['manual', 'onboarding', 'weekly', 'phase_transition', 'reply_sweep'])
    .optional(),
  /**
   * Optional explicit root-agent member id. When absent, the route resolves
   * the team's coordinator member (agent_type='coordinator') — the typical
   * entry point per spec §4.1 request flow.
   */
  rootMemberId: z.string().optional(),
});

/**
 * POST /api/team/run
 *
 * Body: { teamId, goal, trigger?, rootMemberId? }
 * Auth: session user must own the team.
 * Effect: creates a team_runs row (pending) + enqueues the BullMQ job.
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

  if (teamRow.length === 0) {
    return NextResponse.json({ error: 'team_not_found' }, { status: 404 });
  }
  if (teamRow[0].userId !== userId) {
    // Don't leak existence — return 404 to the non-owner.
    return NextResponse.json({ error: 'team_not_found' }, { status: 404 });
  }

  // Resolve the root agent. Explicit rootMemberId wins; otherwise prefer
  // the coordinator. Fall back to an arbitrary member (typically unused,
  // but avoids a 500 in dev teams with a non-standard composition).
  let rootMemberId: string | null = null;
  if (body.rootMemberId) {
    const r = await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.id, body.rootMemberId),
          eq(teamMembers.teamId, body.teamId),
        ),
      )
      .limit(1);
    if (r.length === 0) {
      return NextResponse.json({ error: 'root_member_not_found' }, { status: 400 });
    }
    rootMemberId = r[0].id;
  } else {
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
    if (coordinators.length === 0) {
      // Fall back to any member.
      const any = await db
        .select({ id: teamMembers.id })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, body.teamId))
        .limit(1);
      if (any.length === 0) {
        return NextResponse.json(
          { error: 'team_has_no_members' },
          { status: 400 },
        );
      }
      rootMemberId = any[0].id;
    } else {
      rootMemberId = coordinators[0].id;
    }
  }

  const { runId, traceId, alreadyRunning } = await enqueueTeamRun({
    teamId: body.teamId,
    goal: body.goal,
    trigger: body.trigger ?? 'manual',
    rootMemberId,
  });

  log.info(
    `POST /api/team/run user=${userId} team=${body.teamId} runId=${runId} already=${alreadyRunning}`,
  );

  return NextResponse.json(
    { runId, traceId, alreadyRunning },
    { status: alreadyRunning ? 200 : 202 },
  );
}
