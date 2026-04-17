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

/**
 * POST /api/discovery/scan
 * Fan out a per-platform discovery-scan job for every platform the user has
 * a connected channel on. One scanRunId groups all sources across platforms
 * so scan-status + SSE remain coherent. Global 2-minute debounce per user.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const redis = getKeyValueClient();
  const debounceKey = `shipflare:scan:debounce:${userId}`;
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
    await redis.del(debounceKey);
    return NextResponse.json({ error: 'no product' }, { status: 400 });
  }

  // Which platforms does this user actually have connected? Scan only those.
  const connected = await db
    .select({ platform: channels.platform })
    .from(channels)
    .where(eq(channels.userId, userId));

  const platforms = [...new Set(connected.map((c) => c.platform))].filter(
    isPlatformAvailable,
  );

  if (platforms.length === 0) {
    await redis.del(debounceKey);
    return NextResponse.json(
      { error: 'no connected channels' },
      { status: 400 },
    );
  }

  const scanRunId = `manual-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sources: Array<{ platform: string; source: string }> = [];

  for (const platform of platforms) {
    await enqueueDiscoveryScan({
      schemaVersion: 1,
      traceId: randomUUID(),
      userId,
      productId: product.id,
      platform,
      scanRunId,
      trigger: 'manual',
    });
    const config = getPlatformConfig(platform);
    for (const source of config.defaultSources) {
      sources.push({ platform, source });
    }
  }

  log.info(
    `discovery scan enqueued: scanRunId=${scanRunId} platforms=${platforms.join(',')}`,
  );

  return NextResponse.json(
    { status: 'queued', scanRunId, platforms, sources },
    { status: 202 },
  );
}
