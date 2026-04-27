/**
 * Per-conversation scalar operations.
 *
 *   GET    /api/team/conversations/:id         metadata only (cheap)
 *   DELETE /api/team/conversations/:id         hard-delete (cascades)
 *   PATCH  /api/team/conversations/:id         rename
 */
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { teams, teamConversations } from '@/lib/db/schema';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:team:conversations:id');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

async function loadConvOwnedByUser(
  conversationId: string,
  userId: string,
): Promise<{ id: string; teamId: string; title: string | null } | null> {
  const [row] = await db
    .select({
      id: teamConversations.id,
      teamId: teamConversations.teamId,
      title: teamConversations.title,
      ownerUserId: teams.userId,
    })
    .from(teamConversations)
    .innerJoin(teams, eq(teams.id, teamConversations.teamId))
    .where(eq(teamConversations.id, conversationId))
    .limit(1);
  if (!row || row.ownerUserId !== userId) return null;
  return { id: row.id, teamId: row.teamId, title: row.title };
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;

  const conv = await loadConvOwnedByUser(id, session.user.id);
  if (!conv) {
    return NextResponse.json(
      { error: 'conversation_not_found' },
      { status: 404 },
    );
  }

  return NextResponse.json(
    { id: conv.id, teamId: conv.teamId, title: conv.title },
    { status: 200 },
  );
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function DELETE(
  _request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;

  const conv = await loadConvOwnedByUser(id, session.user.id);
  if (!conv) {
    return NextResponse.json(
      { error: 'conversation_not_found' },
      { status: 404 },
    );
  }

  // Hard delete. `team_runs` and `team_messages` have
  // `ON DELETE SET NULL` for `conversation_id`, so their rows survive
  // (as orphans) — fine for audit; they simply drop out of the
  // sidebar and per-conversation history. If the product ever wants a
  // "soft delete with undo" affordance, add a `deleted_at` column and
  // filter reads rather than physically removing.
  await db.delete(teamConversations).where(eq(teamConversations.id, id));

  log.info(`deleted conversation ${id}`);

  return NextResponse.json({ ok: true }, { status: 200 });
}

// ---------------------------------------------------------------------------
// PATCH — rename
// ---------------------------------------------------------------------------

const patchSchema = z.object({
  title: z.string().min(1).max(200),
});

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;

  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      {
        error: 'invalid_body',
        detail: err instanceof Error ? err.message : 'parse error',
      },
      { status: 400 },
    );
  }

  const conv = await loadConvOwnedByUser(id, session.user.id);
  if (!conv) {
    return NextResponse.json(
      { error: 'conversation_not_found' },
      { status: 404 },
    );
  }

  await db
    .update(teamConversations)
    .set({ title: body.title, updatedAt: new Date() })
    .where(eq(teamConversations.id, id));

  return NextResponse.json({ id, title: body.title }, { status: 200 });
}
