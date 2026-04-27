import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { teams, teamMembers, teamRuns } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/team/status?teamId=<id>
 *
 * Returns a snapshot of the team: members + the currently-running team_run
 * (if any). The `/team` UI calls this on mount before opening the SSE stream.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const teamId = request.nextUrl.searchParams.get('teamId');
  if (!teamId) {
    return NextResponse.json({ error: 'teamId_required' }, { status: 400 });
  }

  const teamRow = await db
    .select({
      id: teams.id,
      userId: teams.userId,
      name: teams.name,
      createdAt: teams.createdAt,
    })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);

  if (teamRow.length === 0 || teamRow[0].userId !== userId) {
    return NextResponse.json({ error: 'team_not_found' }, { status: 404 });
  }

  const members = await db
    .select({
      id: teamMembers.id,
      agent_type: teamMembers.agentType,
      display_name: teamMembers.displayName,
      status: teamMembers.status,
      last_active_at: teamMembers.lastActiveAt,
    })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));

  const activeRows = await db
    .select({
      runId: teamRuns.id,
      goal: teamRuns.goal,
      trigger: teamRuns.trigger,
      startedAt: teamRuns.startedAt,
      turns: teamRuns.totalTurns,
      cost: teamRuns.totalCostUsd,
    })
    .from(teamRuns)
    .where(and(eq(teamRuns.teamId, teamId), eq(teamRuns.status, 'running')))
    .limit(1);

  return NextResponse.json({
    team: {
      id: teamRow[0].id,
      name: teamRow[0].name,
      createdAt: teamRow[0].createdAt,
    },
    members,
    activeRun: activeRows[0] ?? null,
  });
}
