import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { enqueueDiscovery } from '@/lib/queue';
import { publishEvent } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:automation:run');

const DEFAULT_SUBREDDITS = ['SideProject', 'startups', 'webdev'];

/**
 * POST /api/automation/run
 *
 * Triggers the full automation pipeline for the current user's product.
 * Enqueues a discovery job which cascades into content → review → posting.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;

  // Load user's product
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);

  if (!product) {
    return NextResponse.json(
      { error: 'No product configured. Complete onboarding first.' },
      { status: 400 },
    );
  }

  // Use product keywords as subreddit hints, fall back to defaults
  const subreddits =
    product.keywords && product.keywords.length > 0
      ? DEFAULT_SUBREDDITS
      : DEFAULT_SUBREDDITS;

  log.info(
    `Automation triggered for product "${product.name}" (${product.id}), subreddits: ${subreddits.join(', ')}`,
  );

  // Publish launch events so the UI shows agents waking up
  const channel = `shipflare:events:${userId}`;
  await publishEvent(channel, {
    type: 'agent_start',
    agentName: 'scout',
    currentTask: 'Scanning communities...',
  });

  // Enqueue discovery — the worker cascades to content/review/posting
  await enqueueDiscovery({
    userId,
    productId: product.id,
    subreddits,
  });

  return NextResponse.json({
    ok: true,
    product: product.name,
    subreddits,
  });
}
