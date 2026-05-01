import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getGitHubToken } from '@/lib/github';
import { enqueueCodeScan } from '@/lib/queue';
import { getKeyValueClient } from '@/lib/redis';
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

  // Return SSE stream — subscribe to Redis pub/sub for progress updates.
  //
  // Lifecycle is closure-scoped so cancel() can clean up too. Without that,
  // a client disconnect closes the controller while the redis subscription
  // is still live; the next pub/sub message hits controller.enqueue on a
  // closed controller and crashes the process with ERR_INVALID_STATE.
  const channel = `code-scan:${userId}`;
  const encoder = new TextEncoder();
  const redis = getKeyValueClient().duplicate();
  let closed = false;
  let timeoutHandle: NodeJS.Timeout | null = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    redis.unsubscribe(channel).catch(() => {});
    redis.disconnect();
  };

  const stream = new ReadableStream({
    start(controller) {
      const safeEnqueue = (data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Controller closed by client disconnect — release the
          // subscription so subsequent messages don't hit this path.
          cleanup();
        }
      };

      const safeClose = () => {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
        cleanup();
      };

      timeoutHandle = setTimeout(() => {
        safeEnqueue(`data: ${JSON.stringify({ type: 'error', error: 'Scan timed out' })}\n\n`);
        safeClose();
      }, 90_000);

      redis.subscribe(channel, (err) => {
        if (err) {
          log.error(`Redis subscribe error: ${err.message}`);
          safeEnqueue(`data: ${JSON.stringify({ type: 'error', error: 'Stream error' })}\n\n`);
          safeClose();
        }
      });

      redis.on('message', (_ch: string, message: string) => {
        safeEnqueue(`data: ${message}\n\n`);

        try {
          const parsed = JSON.parse(message);
          if (parsed.type === 'complete' || parsed.type === 'error') {
            safeClose();
          }
        } catch {
          // Ignore parse errors
        }
      });
    },
    cancel() {
      // Client disconnected — release the redis subscription so the next
      // pub/sub message doesn't hit a closed controller.
      cleanup();
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
