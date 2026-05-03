// UI-B Task 8: roster hydration endpoint.
//
// Returns the live roster for a team — lead row + all non-terminal
// teammate `agent_runs`. Source of truth is the Redis-first team-state
// cache (`getTeamState`), so this is a hot-path read with DB fallback
// on miss/error. SSE replaces it after initial render: the
// TeammateRoster client component listens for `agent_status_change`
// events on `team:${teamId}:messages` and patches the list in place.
//
// Response shape:
//   { lead: LeadRow | null, teammates: TeammateRow[] }
//
// `lead` is split out from `teammates` because the UI renders the lead
// row separately (always-present, never removed). The team-state cache
// only carries the lead's status / agentId / lastActiveAt — displayName
// + memberId come from a small companion lookup against `teamMembers`.

import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { teams, teamMembers } from '@/lib/db/schema';
import { getTeamState } from '@/lib/team/team-state-cache';
import { getKeyValueClient } from '@/lib/redis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LEAD_AGENT_TYPE = 'coordinator';

export interface TeammateRosterRow {
  agentId: string;
  memberId: string;
  agentDefName: string;
  parentAgentId: string | null;
  status: 'queued' | 'running' | 'sleeping' | 'resuming';
  lastActiveAt: string;
  sleepUntil: string | null;
  displayName: string;
}

export interface LeadRosterRow {
  /** `agent_runs.id` for the lead. Null when the lead has never run yet. */
  agentId: string | null;
  /** `team_members.id` for the lead — always present (Phase E invariant). */
  memberId: string;
  agentDefName: typeof LEAD_AGENT_TYPE;
  /** Display name for the lead row (e.g. "Team Lead"). */
  displayName: string;
  /** Cached lead lifecycle position. Null when the lead has never run. */
  status:
    | 'queued'
    | 'running'
    | 'sleeping'
    | 'resuming'
    | 'completed'
    | 'failed'
    | 'killed'
    | null;
  /** ISO timestamp of last status update; null when never run. */
  lastActiveAt: string | null;
}

export interface TeammatesResponse {
  lead: LeadRosterRow | null;
  teammates: TeammateRosterRow[];
}

/**
 * GET /api/team/[teamId]/teammates
 *
 *   200 { lead, teammates }
 *   400 teamId_required (when route param is empty)
 *   401 unauthorized
 *   404 team_not_found (also covers cross-user access — same response
 *       so the endpoint doesn't leak team existence)
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ teamId: string }> },
): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const { teamId } = await params;
  if (!teamId) {
    return NextResponse.json({ error: 'teamId_required' }, { status: 400 });
  }

  // Auth: team must exist AND belong to the requesting user. Mirror the
  // /api/team/status check so cross-user requests get a 404 (not 403) —
  // we don't want the endpoint to confirm the team's existence to a
  // user that doesn't own it.
  const teamRow = await db
    .select({ id: teams.id, userId: teams.userId })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);
  if (teamRow.length === 0 || teamRow[0].userId !== userId) {
    return NextResponse.json({ error: 'team_not_found' }, { status: 404 });
  }

  const state = await getTeamState(teamId, db, getKeyValueClient());

  // Lookup the lead's `team_members` row for displayName + memberId. The
  // team-state cache deliberately excludes lead from the teammates list
  // and only carries leadStatus/leadAgentId/leadLastActiveAt; we hydrate
  // the rest here so the client renders the lead row without a second
  // round-trip.
  const leadMemberRows = await db
    .select({
      id: teamMembers.id,
      displayName: teamMembers.displayName,
    })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.agentType, LEAD_AGENT_TYPE),
      ),
    )
    .limit(1);

  const lead: LeadRosterRow | null =
    leadMemberRows.length > 0
      ? {
          agentId: state.leadAgentId,
          memberId: leadMemberRows[0].id,
          agentDefName: LEAD_AGENT_TYPE,
          displayName: leadMemberRows[0].displayName,
          status: state.leadStatus,
          lastActiveAt: state.leadLastActiveAt,
        }
      : null;

  const teammates: TeammateRosterRow[] = state.teammates.map((t) => ({
    agentId: t.agentId,
    memberId: t.memberId,
    agentDefName: t.agentDefName,
    parentAgentId: t.parentAgentId,
    status: t.status,
    lastActiveAt: t.lastActiveAt,
    sleepUntil: t.sleepUntil,
    displayName: t.displayName,
  }));

  const body: TeammatesResponse = { lead, teammates };
  return NextResponse.json(body);
}
