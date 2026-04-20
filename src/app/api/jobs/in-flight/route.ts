import { NextResponse } from 'next/server';
import type { Queue } from 'bullmq';
import { auth } from '@/lib/auth';
import {
  discoveryScanQueue,
  codeScanQueue,
  calibrationQueue,
} from '@/lib/queue';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:jobs:in-flight');

/**
 * Kind → queue registry. Each entry maps the public `?kind=` query param to
 * the BullMQ queue carrying jobs whose deterministic id is `${kind}-${userId}`.
 * The UI uses this endpoint to decide whether to lock a "Generate / Scan"
 * button while the user's own job is active or waiting in redis.
 *
 * Keys here MUST match the prefix we use when building `jobId` at enqueue
 * time (see `enqueueCalendarPlan` et al. in `@/lib/queue`).
 */
const KIND_TO_QUEUE: Record<string, Queue<unknown>> = {
  'discovery-scan': discoveryScanQueue as unknown as Queue<unknown>,
  'code-scan': codeScanQueue as unknown as Queue<unknown>,
  calibration: calibrationQueue as unknown as Queue<unknown>,
};

/** BullMQ job states we consider "in flight" for UI lockout purposes. */
const IN_FLIGHT_STATES: ReadonlySet<string> = new Set([
  'active',
  'waiting',
  'waiting-children',
  'delayed',
  'prioritized',
]);

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const kind = searchParams.get('kind');
  if (!kind) {
    return NextResponse.json(
      { error: 'Missing required query param: kind' },
      { status: 400 },
    );
  }

  const queue = KIND_TO_QUEUE[kind];
  if (!queue) {
    return NextResponse.json(
      { error: `Unknown kind: ${kind}` },
      { status: 400 },
    );
  }

  const jobId = `${kind}-${session.user.id}`;

  try {
    const job = await queue.getJob(jobId);
    if (!job) {
      return NextResponse.json({ inFlight: false });
    }
    const state = await job.getState();
    const inFlight = IN_FLIGHT_STATES.has(state);
    return NextResponse.json({
      inFlight,
      ...(inFlight ? { jobId } : {}),
    });
  } catch (err: unknown) {
    log.error(
      `failed to look up ${kind} for user ${session.user.id}:`,
      err instanceof Error ? err.message : String(err),
    );
    // Fail open — a missed lockout is better than wedging the UI.
    return NextResponse.json({ inFlight: false });
  }
}
