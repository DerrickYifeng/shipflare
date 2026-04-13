import { runFullScan } from '@/core/pipelines/full-scan';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:scan');

function sseEncode(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Public scan endpoint — thin SSE wrapper around runFullScan().
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const url = body.url;

  if (!url || typeof url !== 'string') {
    return Response.json({ error: 'URL is required' }, { status: 400 });
  }

  const start = Date.now();
  log.info(`POST /api/scan url=${url}`);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;

      function send(event: string, data: unknown) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseEncode(event, data)));
        } catch {
          closed = true;
        }
      }

      try {
        const result = await runFullScan({
          url,
          onProgress: send,
        });

        log.info(`Scan complete: ${result.results.length} results in ${Date.now() - start}ms`);

        send('complete', {
          product: result.product,
          communities: result.communities,
          communityIntel: result.communityIntel,
          results: result.results,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Scan failed in ${Date.now() - start}ms: ${message}`);
        send('error', { error: `Scan failed: ${message}` });
      } finally {
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

