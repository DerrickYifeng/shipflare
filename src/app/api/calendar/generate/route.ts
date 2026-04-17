import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { enqueueCalendarPlan } from '@/lib/queue';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:calendar:generate');

/**
 * POST /api/calendar/generate
 * Enqueue calendar plan generation as a background job.
 * Returns 202 immediately — the shell planner runs in a BullMQ worker and
 * notifies the frontend via SSE (`type: 'pipeline', pipeline: 'plan'`) as
 * each slot hydrates.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { channel?: string; startDate?: string };
  try {
    body = (await request.json()) as { channel?: string; startDate?: string };
  } catch {
    body = {};
  }

  const channel = body.channel ?? 'x';
  const userId = session.user.id;

  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);

  if (!product) {
    return NextResponse.json(
      { error: 'No product configured. Complete onboarding first.' },
      { status: 400 },
    );
  }

  const startDate = body.startDate ? new Date(body.startDate) : new Date();
  startDate.setMinutes(0, 0, 0);
  startDate.setHours(startDate.getHours() + 1);

  const jobId = await enqueueCalendarPlan({
    userId,
    productId: product.id,
    channel,
    startDate: startDate.toISOString(),
  });

  log.info(`Calendar plan enqueued for channel=${channel}, jobId=${jobId}`);

  return NextResponse.json({ status: 'queued', jobId }, { status: 202 });
}
