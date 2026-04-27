/**
 * Conversations collection endpoints — the ChatGPT-style sidebar
 * primitive.
 *
 *   POST  /api/team/conversations           create a new empty conversation
 *   GET   /api/team/conversations?teamId=X  list conversations (sidebar feed)
 *
 * There is no "active" concept at this layer. A conversation exists;
 * the UI decides which one has focus; every message carries an
 * explicit `conversationId`. Sidebar sorts by `updatedAt DESC`
 * (bumped on every new user message).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { teams, teamConversations, teamMessages } from '@/lib/db/schema';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:team:conversations');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// POST — create
// ---------------------------------------------------------------------------

const createSchema = z.object({
  teamId: z.string().min(1),
  /** Optional display title; when omitted the first user message
   *  content becomes the de-facto title via the messages endpoint's
   *  auto-backfill. */
  title: z.string().max(200).optional(),
});

export async function POST(request: NextRequest): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  let body: z.infer<typeof createSchema>;
  try {
    body = createSchema.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      {
        error: 'invalid_body',
        detail: err instanceof Error ? err.message : 'parse error',
      },
      { status: 400 },
    );
  }

  // Team ownership check.
  const [teamRow] = await db
    .select({ id: teams.id, userId: teams.userId })
    .from(teams)
    .where(eq(teams.id, body.teamId))
    .limit(1);
  if (!teamRow || teamRow.userId !== userId) {
    return NextResponse.json({ error: 'team_not_found' }, { status: 404 });
  }

  const [created] = await db
    .insert(teamConversations)
    .values({
      teamId: body.teamId,
      title: body.title ?? null,
    })
    .returning({
      id: teamConversations.id,
      title: teamConversations.title,
      createdAt: teamConversations.createdAt,
      updatedAt: teamConversations.updatedAt,
    });

  if (!created) {
    return NextResponse.json({ error: 'insert_failed' }, { status: 500 });
  }

  log.info(`team ${body.teamId}: created conversation ${created.id}`);

  return NextResponse.json(
    {
      id: created.id,
      title: created.title,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
      messageCount: 0,
    },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// GET — list
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const teamId = request.nextUrl.searchParams.get('teamId');
  if (!teamId) {
    return NextResponse.json(
      { error: 'missing_teamId' },
      { status: 400 },
    );
  }

  const [teamRow] = await db
    .select({ id: teams.id, userId: teams.userId })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);
  if (!teamRow || teamRow.userId !== userId) {
    return NextResponse.json({ error: 'team_not_found' }, { status: 404 });
  }

  const rows = await db
    .select({
      id: teamConversations.id,
      title: teamConversations.title,
      createdAt: teamConversations.createdAt,
      updatedAt: teamConversations.updatedAt,
    })
    .from(teamConversations)
    .where(eq(teamConversations.teamId, teamId))
    .orderBy(desc(teamConversations.updatedAt))
    .limit(100);

  // Per-conversation message count in a single round-trip via a join.
  // For small totals (<=100 conversations per team), a subquery-per-row
  // is cheap; if this ever becomes hot, promote to a denormalized
  // counter column bumped by the messages endpoint.
  const counts = rows.length
    ? await db
        .select({
          conversationId: teamMessages.conversationId,
          id: teamMessages.id,
        })
        .from(teamMessages)
        .where(eq(teamMessages.teamId, teamId))
    : [];
  const countMap = new Map<string, number>();
  for (const m of counts) {
    if (!m.conversationId) continue;
    countMap.set(m.conversationId, (countMap.get(m.conversationId) ?? 0) + 1);
  }

  return NextResponse.json(
    {
      conversations: rows.map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        messageCount: countMap.get(r.id) ?? 0,
      })),
    },
    { status: 200 },
  );
}
