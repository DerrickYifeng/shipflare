import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { publishUserEvent } from '@/lib/redis';
import { requestStop } from '@/lib/automation-stop';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:automation:stop');

/**
 * POST /api/automation/stop
 *
 * Signals in-flight automation workers to exit at their next safe point.
 * Sets the `automation:stop:${userId}` Redis key (TTL-guarded) and broadcasts
 * a `stop_requested` SSE event so the war-room UI can flip state immediately,
 * without waiting for the next `agent_complete`.
 *
 * Not hard-cancelling: already-running agent turns finish out. Future worker
 * iterations poll `isStopRequested` (see `src/lib/automation-stop.ts`) and
 * unwind.
 */
export async function POST(request: NextRequest) {
  const { log, traceId } = loggerForRequest(baseLog, request);
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;

  await requestStop(userId);
  await publishUserEvent(userId, 'agents', {
    type: 'stop_requested',
  });

  log.info(`Stop requested for user ${userId}`);

  return NextResponse.json({ ok: true, traceId }, { headers: { 'x-trace-id': traceId } });
}
