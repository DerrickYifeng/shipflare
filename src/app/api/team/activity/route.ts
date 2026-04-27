import { NextResponse, type NextRequest } from 'next/server';
import { and, asc, eq, or } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { teams, teamMembers, teamMessages } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function parseIntSafe(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/**
 * GET /api/team/activity?memberId=<id>&limit=100
 *
 * Returns messages where the given member is either sender or recipient,
 * in chronological order. Used to seed the activity log on the member
 * detail page before the SSE stream takes over.
 *
 * Authorization: the member must belong to a team owned by the current
 * session's user.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const memberId = request.nextUrl.searchParams.get('memberId');
  if (!memberId) {
    return NextResponse.json({ error: 'memberId_required' }, { status: 400 });
  }
  const limit = parseIntSafe(
    request.nextUrl.searchParams.get('limit'),
    DEFAULT_LIMIT,
    MAX_LIMIT,
  );

  const memberRows = await db
    .select({
      id: teamMembers.id,
      teamId: teamMembers.teamId,
      agentType: teamMembers.agentType,
      displayName: teamMembers.displayName,
      status: teamMembers.status,
      lastActiveAt: teamMembers.lastActiveAt,
      ownerId: teams.userId,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.id, memberId))
    .limit(1);

  if (memberRows.length === 0 || memberRows[0].ownerId !== userId) {
    return NextResponse.json({ error: 'member_not_found' }, { status: 404 });
  }

  const member = memberRows[0];

  const rows = await db
    .select({
      id: teamMessages.id,
      runId: teamMessages.runId,
      teamId: teamMessages.teamId,
      fromMemberId: teamMessages.fromMemberId,
      toMemberId: teamMessages.toMemberId,
      type: teamMessages.type,
      content: teamMessages.content,
      metadata: teamMessages.metadata,
      createdAt: teamMessages.createdAt,
    })
    .from(teamMessages)
    .where(
      and(
        eq(teamMessages.teamId, member.teamId),
        or(
          eq(teamMessages.fromMemberId, memberId),
          eq(teamMessages.toMemberId, memberId),
        ),
      ),
    )
    .orderBy(asc(teamMessages.createdAt))
    .limit(limit);

  return NextResponse.json({
    member: {
      id: member.id,
      teamId: member.teamId,
      agentType: member.agentType,
      displayName: member.displayName,
      status: member.status,
      lastActiveAt: member.lastActiveAt,
    },
    messages: rows.map((m) => ({
      id: m.id,
      runId: m.runId,
      teamId: m.teamId,
      from: m.fromMemberId,
      to: m.toMemberId,
      type: m.type,
      content: m.content,
      metadata: m.metadata,
      createdAt:
        m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
    })),
  });
}
