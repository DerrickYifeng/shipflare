// SSE endpoint for team-run live events. Subscribers receive a snapshot of
// the most recent team_messages for the team (or run), then a live feed of
// new messages published to `team:${teamId}:messages` by the team-run
// worker + SendMessage tool.
//
// Query params:
//   ?teamId=<id>         — required
//   ?runId=<id>          — optional, filters the snapshot (live feed still
//                           carries the whole team channel so the UI sees
//                           subsequent runs without reconnecting)

import type { NextRequest } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { teams, teamMessages } from '@/lib/db/schema';
import { createPubSubSubscriber } from '@/lib/redis';
import { teamMessagesChannel } from '@/tools/SendMessageTool/SendMessageTool';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:team:events');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SNAPSHOT_LIMIT = 200;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_CONNECTION_MS = 30 * 60_000;

export async function GET(request: NextRequest): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 });
  }
  const userId = session.user.id;

  const params = request.nextUrl.searchParams;
  const teamId = params.get('teamId');
  const runId = params.get('runId');
  if (!teamId) {
    return new Response('teamId required', { status: 400 });
  }

  const teamRows = await db
    .select({ userId: teams.userId })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);

  if (teamRows.length === 0 || teamRows[0].userId !== userId) {
    return new Response('Not found', { status: 404 });
  }

  // Snapshot: most recent messages first (desc by created_at). We flip to
  // chronological order before emitting so the UI can append incrementally.
  const snapshotRows = runId
    ? await db
        .select()
        .from(teamMessages)
        .where(and(eq(teamMessages.teamId, teamId), eq(teamMessages.runId, runId)))
        .orderBy(desc(teamMessages.createdAt))
        .limit(SNAPSHOT_LIMIT)
    : await db
        .select()
        .from(teamMessages)
        .where(eq(teamMessages.teamId, teamId))
        .orderBy(desc(teamMessages.createdAt))
        .limit(SNAPSHOT_LIMIT);

  const snapshot = snapshotRows.slice().reverse();

  const subscriber = createPubSubSubscriber();
  const channel = teamMessagesChannel(teamId);

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let maxAgeTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      function send(payload: Record<string, unknown>): void {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          );
        } catch {
          // Stream closed.
        }
      }
      function sendComment(line: string): void {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ${line}\n\n`));
        } catch {
          // Stream closed.
        }
      }

      send({ type: 'connected', teamId, runId: runId ?? null });
      for (const msg of snapshot) {
        send({
          type: 'snapshot',
          messageId: msg.id,
          runId: msg.runId,
          conversationId: msg.conversationId,
          teamId: msg.teamId,
          from: msg.fromMemberId,
          to: msg.toMemberId,
          messageType: msg.type,
          content: msg.content,
          metadata: msg.metadata,
          createdAt:
            msg.createdAt instanceof Date
              ? msg.createdAt.toISOString()
              : String(msg.createdAt),
        });
      }
      send({ type: 'snapshot_end' });

      subscriber.subscribe(channel).catch((err: Error) => {
        log.warn(`Redis subscribe to ${channel} failed: ${err.message}`);
      });
      subscriber.on('message', (_ch: string, message: string) => {
        if (closed) return;
        try {
          const parsed = JSON.parse(message) as Record<string, unknown>;
          if (runId && parsed.runId && parsed.runId !== runId) {
            // Respect run scoping on the live feed when the client asked for it.
            return;
          }
          // Rename the publish payload's `type` (e.g. 'user_prompt') to
          // `messageType` before forwarding so the wire wrapper `type: 'event'`
          // survives spread — otherwise parsed.type overwrites it and the
          // client's switch falls through to its default branch, silently
          // dropping every live message.
          const { type: messageType, ...rest } = parsed;
          send({ ...rest, type: 'event', messageType });
        } catch {
          // Ignore malformed payloads — never trust external data.
        }
      });

      heartbeat = setInterval(() => sendComment('heartbeat'), HEARTBEAT_INTERVAL_MS);
      maxAgeTimer = setTimeout(() => {
        send({ type: 'reconnect' });
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }, MAX_CONNECTION_MS);
    },
    cancel() {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (maxAgeTimer) clearTimeout(maxAgeTimer);
      subscriber.unsubscribe().catch(() => {});
      subscriber.disconnect();
      log.info(`SSE closed (team=${teamId}, runId=${runId ?? 'all'})`);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
