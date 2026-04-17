import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { xMonitoredTweets, xTargetAccounts, products } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { enqueueMonitor } from '@/lib/queue';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:x:monitor');

/**
 * GET /api/x/monitor
 * List recent monitored tweets with their status and target account info.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const tweets = await db
    .select({
      id: xMonitoredTweets.id,
      tweetId: xMonitoredTweets.tweetId,
      tweetText: xMonitoredTweets.tweetText,
      authorUsername: xMonitoredTweets.authorUsername,
      tweetUrl: xMonitoredTweets.tweetUrl,
      postedAt: xMonitoredTweets.postedAt,
      discoveredAt: xMonitoredTweets.discoveredAt,
      replyDeadline: xMonitoredTweets.replyDeadline,
      status: xMonitoredTweets.status,
      targetUsername: xTargetAccounts.username,
      targetDisplayName: xTargetAccounts.displayName,
      targetCategory: xTargetAccounts.category,
    })
    .from(xMonitoredTweets)
    .innerJoin(
      xTargetAccounts,
      eq(xMonitoredTweets.targetAccountId, xTargetAccounts.id),
    )
    .where(eq(xMonitoredTweets.userId, session.user.id))
    .orderBy(desc(xMonitoredTweets.discoveredAt))
    .limit(50);

  return NextResponse.json({ tweets });
}

/**
 * POST /api/x/monitor
 * Manually trigger a monitor scan for the user's target accounts.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, session.user.id))
    .limit(1);

  if (!product) {
    return NextResponse.json(
      { error: 'No product configured. Complete onboarding first.' },
      { status: 400 },
    );
  }

  await enqueueMonitor({
    userId: session.user.id,
    productId: product.id,
    platform: 'x',
  });

  log.info(`Manual X monitor scan triggered for user ${session.user.id}`);
  return NextResponse.json({ ok: true });
}
