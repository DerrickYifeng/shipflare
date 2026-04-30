/**
 * Per-conversation messages endpoints.
 *
 *   POST /api/team/conversations/:id/messages
 *     Append a user message to this conversation; the server inserts
 *     the `user_prompt` row and enqueues a coordinator run scoped to
 *     THIS conversation id. No guessing — the client is the source of
 *     truth for which conversation the message belongs to.
 *
 *   GET /api/team/conversations/:id/messages
 *     Return the message history for this conversation in chronological
 *     order. Used on conversation switch.
 *
 * This replaces the former `POST /api/team/message` which lived outside
 * the conversations resource and had to infer the target conversation
 * via `ensureActiveConversation`. With a required path parameter,
 * routing becomes trivial and race-free.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  teams,
  teamMembers,
  teamConversations,
  teamMessages,
} from '@/lib/db/schema';
import { getPubSubPublisher } from '@/lib/redis';
import { teamMessagesChannel } from '@/tools/SendMessageTool/SendMessageTool';
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:team:conversations:messages');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Derive a short title from a user message body — first 60 chars,
 * collapse whitespace, trim trailing ellipsis. Used when a
 * conversation was created without a title and the first send lands.
 */
function deriveTitle(body: string): string {
  const cleaned = body.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 60) return cleaned;
  return `${cleaned.slice(0, 60).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// POST — send a message
// ---------------------------------------------------------------------------

const sendSchema = z.object({
  /** Required because ownership checks need the team scope. Clients
   *  already know it from the conversation metadata they fetched; making
   *  it explicit also lets us reject cross-team tampering without a
   *  second DB round-trip. */
  teamId: z.string().min(1),
  memberId: z.string().optional(),
  message: z.string().min(1).max(8000),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(
  request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;
  const { id: conversationId } = await ctx.params;

  let body: z.infer<typeof sendSchema>;
  try {
    body = sendSchema.parse(await request.json());
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

  // Conversation existence + ownership.
  const [conv] = await db
    .select({
      id: teamConversations.id,
      title: teamConversations.title,
    })
    .from(teamConversations)
    .where(
      and(
        eq(teamConversations.id, conversationId),
        eq(teamConversations.teamId, body.teamId),
      ),
    )
    .limit(1);
  if (!conv) {
    return NextResponse.json(
      { error: 'conversation_not_found' },
      { status: 404 },
    );
  }

  // Optional member target (for targeted sends to a specific specialist).
  let toMemberId: string | null = null;
  if (body.memberId) {
    const [member] = await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.id, body.memberId),
          eq(teamMembers.teamId, body.teamId),
        ),
      )
      .limit(1);
    if (!member) {
      return NextResponse.json(
        { error: 'member_not_found' },
        { status: 400 },
      );
    }
    toMemberId = member.id;
  }

  // Find the coordinator (root agent for the spawned run).
  const [coordinator] = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, body.teamId),
        eq(teamMembers.agentType, 'coordinator'),
      ),
    )
    .limit(1);

  const rootMemberId = coordinator?.id ?? toMemberId;
  if (!rootMemberId) {
    return NextResponse.json(
      {
        error: 'no_root_member',
        detail:
          'Team has no coordinator and no explicit member was supplied — cannot spawn a run to process the message.',
      },
      { status: 400 },
    );
  }

  // Enqueue the coordinator run scoped to THIS conversation. Inline
  // chat messages share the `daily` playbook entry (coordinator falls
  // back to "review state + propose actions" when the goal text doesn't
  // match a known trigger pattern).
  const enqueued = await enqueueTeamRun({
    teamId: body.teamId,
    trigger: 'daily',
    goal: body.message,
    rootMemberId,
    conversationId,
  });

  // Insert the user_prompt row. Must carry the enqueued runId so the
  // coordinator reconstructs history correctly and the UI's SSE
  // subscriber associates the bubble with the right thread.
  const messageId = crypto.randomUUID();
  const createdAt = new Date();
  await db.insert(teamMessages).values({
    id: messageId,
    runId: enqueued.runId,
    teamId: body.teamId,
    conversationId,
    fromMemberId: null, // user
    toMemberId,
    type: 'user_prompt',
    content: body.message,
    contentBlocks: [{ type: 'text', text: body.message }],
    metadata: { trigger: 'conversation_message' },
    createdAt,
  });

  // Bump conversation.updated_at so the sidebar sort surfaces it.
  // Also backfill title from the first user message if still null.
  const patch: { updatedAt: Date; title?: string } = { updatedAt: createdAt };
  if (!conv.title) patch.title = deriveTitle(body.message);
  await db
    .update(teamConversations)
    .set(patch)
    .where(eq(teamConversations.id, conversationId));

  // SSE echo for the composer's immediate rendering.
  try {
    await getPubSubPublisher().publish(
      teamMessagesChannel(body.teamId),
      JSON.stringify({
        messageId,
        runId: enqueued.runId,
        teamId: body.teamId,
        conversationId,
        from: null,
        to: toMemberId,
        type: 'user_prompt',
        content: body.message,
        createdAt: createdAt.toISOString(),
      }),
    );
  } catch (err) {
    log.warn(
      `SSE publish failed for team ${body.teamId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  log.info(
    `team ${body.teamId}: message ${messageId.slice(0, 8)} → conversation ${conversationId.slice(0, 8)} → run ${enqueued.runId.slice(0, 8)}`,
  );

  return NextResponse.json(
    {
      messageId,
      runId: enqueued.runId,
      traceId: enqueued.traceId,
      conversationId,
      title: patch.title ?? conv.title,
    },
    { status: 202 },
  );
}

// ---------------------------------------------------------------------------
// GET — list messages for this conversation
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;
  const { id: conversationId } = await ctx.params;

  // Join to teams through conversation for ownership check in one query.
  const [conv] = await db
    .select({
      id: teamConversations.id,
      teamId: teamConversations.teamId,
      ownerUserId: teams.userId,
      title: teamConversations.title,
      updatedAt: teamConversations.updatedAt,
    })
    .from(teamConversations)
    .innerJoin(teams, eq(teams.id, teamConversations.teamId))
    .where(eq(teamConversations.id, conversationId))
    .limit(1);

  if (!conv || conv.ownerUserId !== userId) {
    return NextResponse.json(
      { error: 'conversation_not_found' },
      { status: 404 },
    );
  }

  const messages = await db
    .select({
      id: teamMessages.id,
      runId: teamMessages.runId,
      fromMemberId: teamMessages.fromMemberId,
      toMemberId: teamMessages.toMemberId,
      type: teamMessages.type,
      content: teamMessages.content,
      contentBlocks: teamMessages.contentBlocks,
      metadata: teamMessages.metadata,
      createdAt: teamMessages.createdAt,
    })
    .from(teamMessages)
    .where(eq(teamMessages.conversationId, conversationId))
    .orderBy(asc(teamMessages.createdAt));

  return NextResponse.json(
    {
      conversationId,
      title: conv.title,
      updatedAt: conv.updatedAt.toISOString(),
      messages: messages.map((m) => ({
        ...m,
        createdAt: m.createdAt.toISOString(),
      })),
    },
    { status: 200 },
  );
}
