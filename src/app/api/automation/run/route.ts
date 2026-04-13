import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { enqueueDiscovery } from '@/lib/queue';
import { publishEvent } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:automation:run');

const DEFAULT_SUBREDDITS = ['SideProject', 'startups', 'webdev'];
const DEFAULT_X_TOPICS = ['SaaS', 'startup tools', 'indie hacker'];

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
      { error: 'No product configured. Complete onboarding first.', code: 'NO_PRODUCT' },
      { status: 400 },
    );
  }

  // Check for at least one connected channel (Reddit or X)
  const { channels } = await import('@/lib/db/schema');
  const userChannels = await db
    .select()
    .from(channels)
    .where(eq(channels.userId, userId));

  const redditChannel = userChannels.find((c) => c.platform === 'reddit');
  const xChannel = userChannels.find((c) => c.platform === 'x');

  if (!redditChannel && !xChannel) {
    return NextResponse.json(
      { error: 'Connect a Reddit or X account first.', code: 'NO_CHANNEL' },
      { status: 400 },
    );
  }

  const subreddits = DEFAULT_SUBREDDITS;
  const xTopics = DEFAULT_X_TOPICS;
  const platforms: string[] = [];

  // Publish launch events so the UI shows agents waking up
  const eventChannel = `shipflare:events:${userId}`;
  await publishEvent(eventChannel, {
    type: 'agent_start',
    agentName: 'scout',
    currentTask: 'Scanning communities...',
  });

  // Enqueue Reddit discovery if connected
  if (redditChannel) {
    platforms.push('reddit');
    await enqueueDiscovery({
      userId,
      productId: product.id,
      sources: subreddits,
      platform: 'reddit',
    });
  }

  // Enqueue X discovery if connected + xAI API key is available
  if (xChannel && process.env.XAI_API_KEY) {
    platforms.push('x');
    await enqueueDiscovery({
      userId,
      productId: product.id,
      sources: xTopics,
      platform: 'x',
    });
  }

  log.info(
    `Automation triggered for product "${product.name}" (${product.id}), platforms: ${platforms.join(', ')}`,
  );

  return NextResponse.json({
    ok: true,
    product: product.name,
    platforms,
    subreddits: redditChannel ? subreddits : undefined,
    topics: xChannel ? xTopics : undefined,
  });
}
