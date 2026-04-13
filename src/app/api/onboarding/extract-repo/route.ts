import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getGitHubToken } from '@/lib/github';
import { enqueueCodeScan } from '@/lib/queue';
import { getRedis } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:extract-repo');

/**
 * POST /api/onboarding/extract-repo
 * Enqueues a code-scan job and returns an SSE stream with progress.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { repoFullName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { repoFullName } = body;
  if (!repoFullName || typeof repoFullName !== 'string') {
    return NextResponse.json({ error: 'repoFullName is required' }, { status: 400 });
  }

  // Validate format: "owner/repo"
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoFullName)) {
    return NextResponse.json({ error: 'Invalid repo format' }, { status: 400 });
  }

  const token = await getGitHubToken(session.user.id);
  if (!token) {
    return NextResponse.json({ error: 'No GitHub account linked' }, { status: 404 });
  }

  log.info(`POST /api/onboarding/extract-repo repo=${repoFullName}`);

  const repoUrl = `https://github.com/${repoFullName}`;
  const userId = session.user.id;

  // Enqueue the scan job
  await enqueueCodeScan({
    userId,
    repoFullName,
    repoUrl,
    githubToken: token,
  });

  // Return SSE stream — subscribe to Redis pub/sub for progress updates
  const channel = `code-scan:${userId}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const redis = getRedis().duplicate();

      const cleanup = () => {
        redis.unsubscribe(channel).catch(() => {});
        redis.disconnect();
      };

      // Set a timeout to prevent hanging connections
      const timeout = setTimeout(() => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: 'Scan timed out' })}\n\n`));
        controller.close();
        cleanup();
      }, 90_000);

      redis.subscribe(channel, (err) => {
        if (err) {
          log.error(`Redis subscribe error: ${err.message}`);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: 'Stream error' })}\n\n`));
          controller.close();
          clearTimeout(timeout);
          cleanup();
        }
      });

      redis.on('message', (_ch: string, message: string) => {
        controller.enqueue(encoder.encode(`data: ${message}\n\n`));

        try {
          const parsed = JSON.parse(message);
          if (parsed.type === 'complete' || parsed.type === 'error') {
            clearTimeout(timeout);
            controller.close();
            cleanup();
          }
        } catch {
          // Ignore parse errors
        }
      });
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
