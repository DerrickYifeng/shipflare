/**
 * GET /api/onboarding/reddit-research/status
 *
 * Returns the founder-visible status of the kickoff "find the right
 * subreddits" pass for this product.
 *
 *  - `done`    : at least one `source='auto'` row exists on
 *                product_reddit_channels.
 *  - `pending` : 0 auto rows AND there is an in-flight BullMQ job
 *                (waiting/active/delayed) on the reddit-channel-research
 *                queue keyed to this product. Also the safe default while
 *                BullMQ is mid-ack.
 *  - `failed`  : 0 auto rows AND a recent job (≤ 5 min) for this product
 *                ended with state=failed.
 *
 * The onboarding card polls this endpoint every 3s while pending and stops
 * once it reads `done` or `failed`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products, productRedditChannels } from '@/lib/db/schema';
import { redditChannelResearchQueue } from '@/lib/queue';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:onboarding:reddit-research:status');

/** Window for counting recently-failed jobs (ms). */
const RECENT_FAILURE_WINDOW_MS = 5 * 60_000;

export async function GET(request: NextRequest): Promise<Response> {
  const { traceId } = loggerForRequest(baseLog, request);
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'x-trace-id': traceId } },
    );
  }

  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, session.user.id))
    .limit(1);
  if (!product) {
    return NextResponse.json(
      { error: 'no_product' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }

  const autos = await db
    .select({ id: productRedditChannels.id })
    .from(productRedditChannels)
    .where(
      and(
        eq(productRedditChannels.productId, product.id),
        eq(productRedditChannels.source, 'auto'),
      ),
    )
    .limit(1);
  if (autos.length > 0) {
    return NextResponse.json(
      { status: 'done' as const, count: autos.length },
      { headers: { 'x-trace-id': traceId } },
    );
  }

  // No auto rows yet — check BullMQ for in-flight or recently-failed
  // jobs. We can't filter `getJobs` by data, so pull a small window and
  // filter by data.productId in JS. 50 is plenty for a kickoff queue
  // that processes a few jobs per minute system-wide.
  const recent = await redditChannelResearchQueue.getJobs(
    ['waiting', 'active', 'delayed', 'failed'],
    0,
    50,
  );
  const matches = recent.filter((j) => j.data?.productId === product.id);

  let inFlight = false;
  let recentlyFailed = false;
  for (const j of matches) {
    const state = await j.getState();
    if (state === 'waiting' || state === 'active' || state === 'delayed') {
      inFlight = true;
      break;
    }
    if (
      state === 'failed' &&
      typeof j.finishedOn === 'number' &&
      Date.now() - j.finishedOn < RECENT_FAILURE_WINDOW_MS
    ) {
      recentlyFailed = true;
    }
  }

  if (inFlight) {
    return NextResponse.json(
      { status: 'pending' as const, count: 0 },
      { headers: { 'x-trace-id': traceId } },
    );
  }
  if (recentlyFailed) {
    return NextResponse.json(
      { status: 'failed' as const, count: 0 },
      { headers: { 'x-trace-id': traceId } },
    );
  }
  // Default: pending. Either the job hasn't been enqueued yet, or it's
  // sitting in a window we don't track (e.g. completed but produced 0
  // rows). Polling will resolve.
  return NextResponse.json(
    { status: 'pending' as const, count: 0 },
    { headers: { 'x-trace-id': traceId } },
  );
}
