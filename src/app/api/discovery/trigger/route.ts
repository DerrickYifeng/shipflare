import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products, channels } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { enqueueDiscovery } from '@/lib/queue';
import { PLATFORMS, isPlatformAvailable } from '@/lib/platform-config';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:discovery:trigger');

/**
 * POST /api/discovery/trigger
 * Manually trigger discovery across all connected platforms.
 */
export async function POST(req: NextRequest) {
  const { log, traceId } = loggerForRequest(baseLog, req);
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

  const userChannels = await db
    .select({ platform: channels.platform })
    .from(channels)
    .where(eq(channels.userId, session.user.id));

  const connectedPlatforms = [...new Set(userChannels.map((c) => c.platform))].filter(isPlatformAvailable);

  if (connectedPlatforms.length === 0) {
    return NextResponse.json(
      { error: 'No connected social accounts. Connect at least one platform.' },
      { status: 400 },
    );
  }

  const queued: string[] = [];

  for (const platformId of connectedPlatforms) {
    const config = PLATFORMS[platformId as keyof typeof PLATFORMS];
    if (!config) continue;

    await enqueueDiscovery({
      userId: session.user.id,
      productId: product.id,
      sources: config.defaultSources,
      platform: platformId,
      traceId,
    });
    queued.push(platformId);
  }

  log.info(`Discovery triggered for ${queued.length} platforms: ${queued.join(', ')}`);

  return NextResponse.json(
    { status: 'queued', platforms: queued, traceId },
    { headers: { 'x-trace-id': traceId } },
  );
}
