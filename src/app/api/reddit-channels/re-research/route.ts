/**
 * POST /api/reddit-channels/re-research
 *
 * Founder-triggered re-run of the kickoff subreddit research. Enqueues a
 * fresh `reddit-channel-research` BullMQ job with `force=true` so the
 * worker overwrites any prior `source='auto'` rows for the product.
 *
 * The non-force jobId space (`rcr:<productId>`) collapses concurrent
 * onboarding-commit enqueues at the BullMQ level; this endpoint always
 * appends a timestamp suffix so explicit user intent isn't deduped against
 * an in-flight commit-triggered run.
 *
 * Auth: requires a signed-in session and an owned product (we never accept
 * productId from the client — it's derived from the session).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { enqueueRedditChannelResearch } from '@/lib/queue';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:reddit-channels:re-research');

export async function POST(request: NextRequest): Promise<Response> {
  const { log, traceId } = loggerForRequest(baseLog, request);

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

  await enqueueRedditChannelResearch({
    userId: session.user.id,
    productId: product.id,
    // Explicit founder action — overwrite prior auto rows.
    force: true,
  });
  log.info(`re-research enqueued for product ${product.id}`);

  return NextResponse.json(
    { ok: true },
    { headers: { 'x-trace-id': traceId } },
  );
}
