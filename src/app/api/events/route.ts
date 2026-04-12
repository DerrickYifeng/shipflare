import { auth } from '@/lib/auth';
import { createPubSubSubscriber } from '@/lib/redis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  const channel = `shipflare:events:${userId}`;
  const subscriber = createPubSubSubscriber();

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      function send(data: string) {
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
      const heartbeat = setInterval(() => {
        send(JSON.stringify({ type: 'heartbeat' }));
      }, 30_000);

      // Cleanup on stream close
      const cleanup = () => {
        clearInterval(heartbeat);
        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.disconnect();
      };

      // Handle client disconnect
      const signal = new AbortController().signal;
      signal.addEventListener('abort', cleanup, { once: true });

      // Store cleanup for external abort
      (controller as unknown as { _cleanup: () => void })._cleanup = cleanup;
    },
    cancel() {
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
