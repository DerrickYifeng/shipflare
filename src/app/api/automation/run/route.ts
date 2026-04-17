import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { enqueueDiscovery } from '@/lib/queue';
import { publishEvent } from '@/lib/redis';
import { createLogger } from '@/lib/logger';
import { PLATFORMS, isPlatformAvailable } from '@/lib/platform-config';

const log = createLogger('api:automation:run');

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

  // Check for at least one connected channel on any known platform.
  // Whitelist projection — we only need platform identity to route enqueues.
  const { channels } = await import('@/lib/db/schema');
  const userChannels = await db
    .select({
      id: channels.id,
      platform: channels.platform,
    })
    .from(channels)
    .where(eq(channels.userId, userId));

  const connectedKnown = userChannels.filter((c) => c.platform in PLATFORMS);
  if (connectedKnown.length === 0) {
    const supported = Object.values(PLATFORMS)
      .map((p) => p.displayName)
      .join(' or ');
    return NextResponse.json(
      { error: `Connect a ${supported} account first.`, code: 'NO_CHANNEL' },
      { status: 400 },
    );
  }

  const activePlatforms: string[] = [];

  // Publish launch events so the UI shows agents waking up
  const eventChannel = `shipflare:events:${userId}`;
  await publishEvent(eventChannel, {
    type: 'agent_start',
    agentName: 'scout',
    currentTask: 'Scanning communities...',
  });

  // Enqueue discovery for each connected + available platform
  for (const [platformId, config] of Object.entries(PLATFORMS)) {
    const channel = userChannels.find((c) => c.platform === platformId);
    if (!channel || !isPlatformAvailable(platformId)) continue;

    activePlatforms.push(platformId);
    await enqueueDiscovery({
      userId,
      productId: product.id,
      sources: config.defaultSources,
      platform: platformId,
    });
  }

  log.info(
    `Automation triggered for product "${product.name}" (${product.id}), platforms: ${activePlatforms.join(', ')}`,
  );

  return NextResponse.json({
    ok: true,
    product: product.name,
    platforms: activePlatforms,
  });
}
