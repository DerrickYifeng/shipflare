import { runFullScan } from '@/core/pipelines/full-scan';
import { createLogger } from '@/lib/logger';
import { auth } from '@/lib/auth';
import { getRedis } from '@/lib/redis';

const log = createLogger('api:scan');

function sseEncode(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Atomic INCR + EXPIRE (sets TTL only on the first request in the window).
 * Returns whether the request is allowed and the Retry-After seconds if not.
 */
async function enforceRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const redis = getRedis();
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  if (count > limit) {
    const ttl = await redis.ttl(key);
    return {
      allowed: false,
      retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function getClientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip') ?? 'unknown';
}

/**
 * Public scan endpoint — thin SSE wrapper around runFullScan().
 *
 * Rate limiting:
 *   - Authenticated users: concurrency <= 1 (1 scan per 60s per user).
 *   - Anonymous users: 1 scan per hour per IP.
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

  // Authenticate (optional — anonymous users get stricter IP limit)
  const session = await auth();
  const userId = session?.user?.id ?? null;

  let rateLimit: RateLimitResult;
  if (userId) {
    // Logged-in: concurrency <= 1 in a 60s window
    rateLimit = await enforceRateLimit(
      `ratelimit:scan:user:${userId}`,
      1,
      60,
    );
  } else {
    // Anonymous: 1 request per hour per IP
    const ip = getClientIp(request);
    rateLimit = await enforceRateLimit(
      `ratelimit:scan:ip:${ip}`,
      1,
      3600,
    );
  }

  if (!rateLimit.allowed) {
    log.warn(
      `Scan rate limited (${userId ? `user=${userId}` : `ip=${getClientIp(request)}`}) retryAfter=${rateLimit.retryAfterSeconds}s`,
    );
    return Response.json(
      {
        error: 'rate_limited',
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  const start = Date.now();
  log.info(`POST /api/scan url=${url} user=${userId ?? 'anon'}`);

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
