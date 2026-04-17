import { auth } from '@/lib/auth';
import { createPubSubSubscriber } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:events');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Force the client to reconnect after this long so connections don't live forever. */
const MAX_CONNECTION_MS = 30 * 60 * 1000; // 30 minutes

/**
 * SSE endpoint for real-time dashboard updates.
 * Each client gets its own Redis pub/sub subscriber.
 * Channel: shipflare:events:{userId}
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 });
  }

  const userId = session.user.id;
  log.info(`SSE connection opened for user ${userId}`);

  const channel = `shipflare:events:${userId}`;
  const subscriber = createPubSubSubscriber();

  // Closure-scoped handles that both start() and cancel() can see.
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let maxAgeTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      function send(data: string) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          // Stream closed
        }
      }

      // Subscribe to user's event channel
      subscriber.subscribe(channel).then(() => {
        send(JSON.stringify({ type: 'connected' }));
      });

      subscriber.on('message', (_ch: string, message: string) => {
        send(message);
      });

      // Heartbeat every 30s to keep connection alive
      heartbeat = setInterval(() => {
        send(JSON.stringify({ type: 'heartbeat' }));
      }, 30_000);

      // Force clients to reconnect after MAX_CONNECTION_MS so SSE connections
      // don't live forever (protects against idle socket accumulation).
      maxAgeTimer = setTimeout(() => {
        log.info(`SSE max-age reached for user ${userId}, closing to force reconnect`);
        send(JSON.stringify({ type: 'reconnect' }));
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }, MAX_CONNECTION_MS);
    },
    cancel() {
      if (closed) return;
      closed = true;
      log.info(`SSE connection closed for user ${userId}`);
      if (heartbeat) clearInterval(heartbeat);
      if (maxAgeTimer) clearTimeout(maxAgeTimer);
      subscriber.unsubscribe().catch(() => {});
      subscriber.disconnect();
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
