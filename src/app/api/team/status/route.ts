import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { teams, teamMembers } from '@/lib/db/schema';
import { getTeamState } from '@/lib/team/team-state-cache';
import { getKeyValueClient } from '@/lib/redis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/team/status?teamId=<id>
 *
 * Returns a snapshot of the team: members + the currently-running team_run
 * (if any). The `/team` UI calls this on mount before opening the SSE stream.
 *
 * UI-D Task 3: `activeRun` is now derived from the Redis-first team state
 * cache (`getTeamState`) instead of a direct `agent_runs` SELECT. The
 * cache module owns the DB fallback / write-through coherence story; the
 * route just maps the cached shape into the UI's existing
 * `{ runId, status, lastActiveAt }` envelope so consumers stay unchanged.
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

  // Phase E retired team_runs as the source of truth for "is the lead
  // currently running"; the lead's own row in agent_runs (agentDefName
  // = 'coordinator') now carries that state. UI-D Task 3 routes that
  // read through the team-state cache so /api/team/status is a Redis
  // GET on the hot path. We preserve the response field name `runId`
  // for UI compat — semantics changed from team_runs.id to
  // agent_runs.id (the lead's). Legacy fields
  // (goal/trigger/startedAt/turns/cost) live on derived sources now.
  const teamState = await getTeamState(teamId, db, getKeyValueClient());
  const activeRun =
    teamState.leadStatus === 'running' || teamState.leadStatus === 'resuming'
      ? {
          runId: teamState.leadAgentId,
          status: teamState.leadStatus,
          lastActiveAt: teamState.leadLastActiveAt,
        }
      : null;

  return NextResponse.json({
    team: {
      id: teamRow[0].id,
      name: teamRow[0].name,
      createdAt: teamRow[0].createdAt,
    },
    members,
    activeRun,
  });
}
