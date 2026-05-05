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
import { redactMessageRowForClient } from '@/lib/team/redact-for-client';

const log = createLogger('api:team:events');

/**
 * Snapshot row shape — mirrors the columns we project from `team_messages`.
 * Kept narrow on purpose so this helper documents the redaction contract.
 */
interface SnapshotRow {
  id: string;
  runId: string | null;
  conversationId?: string | null;
  teamId: string;
  fromMemberId: string | null;
  toMemberId: string | null;
  type: string;
  content: string | null;
  contentBlocks?: unknown;
  metadata: unknown;
  createdAt: Date | string;
}

/**
 * Build a redacted snapshot frame for a single team_messages row.
 *
 * Exported (and unit-tested separately) so the per-row transformation is
 * pinned by a fast deterministic test instead of a streaming SSE harness.
 * The live-pubsub forwarder uses the same `redactMessageRowForClient` call
 * directly — covering this helper covers the meaningful redaction logic for
 * both leak points.
 */
export function buildSnapshotFrame(msg: SnapshotRow): Record<string, unknown> {
  const redacted = redactMessageRowForClient({
    id: msg.id,
    runId: msg.runId,
    teamId: msg.teamId,
    conversationId: msg.conversationId ?? null,
    fromMemberId: msg.fromMemberId,
    toMemberId: msg.toMemberId,
    type: msg.type,
    content: msg.content,
    contentBlocks: msg.contentBlocks,
    metadata: (msg.metadata as Record<string, unknown> | null) ?? null,
    createdAt: msg.createdAt,
  });
  return {
    type: 'snapshot',
    messageId: redacted.id,
    runId: redacted.runId,
    conversationId: redacted.conversationId,
    teamId: redacted.teamId,
    from: redacted.fromMemberId,
    to: redacted.toMemberId,
    messageType: redacted.type,
    content: redacted.content,
    contentBlocks: redacted.contentBlocks,
    metadata: redacted.metadata,
    createdAt:
      redacted.createdAt instanceof Date
        ? redacted.createdAt.toISOString()
        : String(redacted.createdAt),
  };
}

/**
 * Build a redacted live-event frame from a parsed pubsub payload.
 *
 * The pubsub payload uses renamed keys (`from`/`to`/`messageId`) at publish
 * time; we map them back to the canonical field names the redactor expects,
 * then merge the redacted fields back over the original spread. The wire
 * wrapper fields (`type: 'event'`, `messageType`) come LAST so they are not
 * accidentally overwritten by `rest.type`.
 */
export function buildLiveEventFrame(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const { type: messageType, ...rest } = parsed;
  const redacted = redactMessageRowForClient({
    id: (rest.messageId as string) ?? '',
    runId: (rest.runId as string | null) ?? null,
    teamId: (rest.teamId as string) ?? '',
    conversationId: (rest.conversationId as string | null) ?? null,
    fromMemberId: (rest.from as string | null) ?? null,
    toMemberId: (rest.to as string | null) ?? null,
    type: String(messageType ?? 'unknown'),
    content: (rest.content as string | null) ?? null,
    contentBlocks: (rest.contentBlocks as unknown) ?? null,
    metadata: (rest.metadata as Record<string, unknown> | null) ?? null,
    createdAt: (rest.createdAt as string) ?? new Date().toISOString(),
  });
  return {
    ...rest,
    content: redacted.content,
    contentBlocks: redacted.contentBlocks,
    metadata: redacted.metadata,
    type: 'event',
    messageType,
  };
}

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
        send(buildSnapshotFrame(msg));
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
          // dropping every live message. `buildLiveEventFrame` also
          // redacts content/contentBlocks/metadata via the shared helper so
          // raw tool_input / tool_output / vendor-bound tool names never
          // reach paying users in DevTools.
          send(buildLiveEventFrame(parsed));
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
