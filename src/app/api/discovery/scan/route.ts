import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products, channels } from '@/lib/db/schema';
import { enqueueDiscoveryScan } from '@/lib/queue';
import { getPlatformConfig, isPlatformAvailable } from '@/lib/platform-config';
import { getKeyValueClient } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:discovery:scan');
const DEBOUNCE_SECONDS = 120;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const body = (await request.json().catch(() => ({}))) as { platform?: string };
  const platform = body.platform ?? 'reddit';
  if (!isPlatformAvailable(platform)) {
    return NextResponse.json({ error: 'platform unavailable' }, { status: 400 });
  }

  const redis = getKeyValueClient();
  const debounceKey = `shipflare:scan:debounce:${userId}:${platform}`;
  const debounceHit = await redis.set(debounceKey, '1', 'EX', DEBOUNCE_SECONDS, 'NX');
  if (debounceHit === null) {
    const ttl = await redis.ttl(debounceKey);
    return NextResponse.json(
      { error: 'rate_limited', retryAfterSeconds: ttl > 0 ? ttl : DEBOUNCE_SECONDS },
      { status: 429 },
    );
  }

  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);
  if (!product) {
    return NextResponse.json({ error: 'no product' }, { status: 400 });
  }

  const [channel] = await db
    .select({
      id: channels.id,
      userId: channels.userId,
      platform: channels.platform,
      username: channels.username,
    })
    .from(channels)
    .where(eq(channels.userId, userId))
    .limit(1);
  if (!channel) {
    return NextResponse.json({ error: 'no channel' }, { status: 400 });
  }

  const config = getPlatformConfig(platform);
  const scanRunId = `manual-${Date.now()}-${randomUUID().slice(0, 8)}`;

  await enqueueDiscoveryScan({
    schemaVersion: 1,
    traceId: randomUUID(),
    userId,
    productId: product.id,
    platform,
    scanRunId,
    trigger: 'manual',
  });

  log.info(`discovery scan enqueued: scanRunId=${scanRunId} platform=${platform}`);

  return NextResponse.json(
    { status: 'queued', scanRunId, sources: config.defaultSources },
    { status: 202 },
  );
}
