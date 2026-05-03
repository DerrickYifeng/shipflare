// UI-B Task 11: per-teammate cancel endpoint.
//
// POST /api/team/agent/[agentId]/cancel
//
// Schedules a graceful cancel for the target `agent_runs` row by
// inserting a `shutdown_request` (delegated to `cancelTeammate`). The
// status='killed' transition that follows is published over SSE by the
// agent-run loop (Phase C Task 7 + UI-B Task 3's `publishStatusChange`)
// — that's how the roster auto-removes the row, no client cleanup
// needed.
//
// Auth: mirrors the transcript endpoint (Task 9). Ownership is
// verified via `agent_runs.team_id → teams.user_id`. Cross-user
// access returns 404 (not 403) so the endpoint doesn't leak agentId
// existence to users that don't own it.

import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { agentRuns, teams } from '@/lib/db/schema';
import { cancelTeammate } from '@/lib/team/cancel-teammate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface CancelTeammateResponse {
  cancelled: true;
  agentId: string;
}

/**
 * POST /api/team/agent/[agentId]/cancel
 *
 *   200 { cancelled: true, agentId }
 *   400 agentId_required
 *   401 unauthorized
 *   404 not_found (also covers cross-user access)
 *   500 cancel_failed (when the helper throws unexpectedly)
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const { agentId } = await params;
  if (!agentId) {
    return NextResponse.json({ error: 'agentId_required' }, { status: 400 });
  }

  // Ownership check — same shape as the transcript endpoint so the two
  // routes stay in lockstep on the auth model. 404 on both "no row"
  // and "owned by someone else" prevents existence probing.
  const ownerRows = await db
    .select({ userId: teams.userId })
    .from(agentRuns)
    .innerJoin(teams, eq(teams.id, agentRuns.teamId))
    .where(eq(agentRuns.id, agentId))
    .limit(1);
  if (ownerRows.length === 0 || ownerRows[0].userId !== userId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  try {
    await cancelTeammate(agentId, db);
  } catch (error: unknown) {
    // The helper throws "agent_runs ... not found" only if the row is
    // deleted between our ownership check and the helper's lookup —
    // surface as 404 in that race. Anything else is a real failure.
    const message = error instanceof Error ? error.message : 'unknown error';
    if (/not found/.test(message)) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: 'cancel_failed', detail: message },
      { status: 500 },
    );
  }

  const body: CancelTeammateResponse = { cancelled: true, agentId };
  return NextResponse.json(body);
}
