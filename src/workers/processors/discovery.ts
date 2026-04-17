import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { channels, products } from '@/lib/db/schema';
import { enqueueDiscoveryScan } from '@/lib/queue';
import { isStopRequested } from '@/lib/automation-stop';
import { isPlatformAvailable } from '@/lib/platform-config';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { DiscoveryJobData } from '@/lib/queue/types';
import { isFanoutJob } from '@/lib/queue/types';
import { randomUUID } from 'node:crypto';

const baseLog = createLogger('worker:discovery');

/**
 * Slim shim. Delegates all real work to `discovery-scan.ts` (which fans out
 * per-source `search-source` jobs). Kept so existing cron and API callers
 * that still enqueue `discovery` jobs keep functioning during rollout.
 */
export async function processDiscovery(job: Job<DiscoveryJobData>) {
  const log = loggerForJob(baseLog, job);

  if (isFanoutJob(job.data)) {
    // Cron tick: one discovery-scan job per (user, connected platform).
    // Explicit projection on `channels` — never select token columns here.
    const allChannels = await db
      .select({ userId: channels.userId, platform: channels.platform })
      .from(channels);

    const userPlatforms = new Map<string, Set<string>>();
    for (const ch of allChannels) {
      if (!userPlatforms.has(ch.userId)) userPlatforms.set(ch.userId, new Set());
      userPlatforms.get(ch.userId)!.add(ch.platform);
    }

    let enqueued = 0;
    for (const [uid, platformSet] of userPlatforms) {
      if (await isStopRequested(uid)) continue;
      const [product] = await db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.userId, uid))
        .limit(1);
      if (!product) continue;

      for (const platform of platformSet) {
        if (!isPlatformAvailable(platform)) continue;
        await enqueueDiscoveryScan({
          schemaVersion: 1,
          traceId: randomUUID(),
          userId: uid,
          productId: product.id,
          platform,
          scanRunId: `cron-${Date.now()}-${randomUUID().slice(0, 8)}`,
          trigger: 'cron',
        });
        enqueued++;
      }
    }
    log.info(`cron fan-out: enqueued ${enqueued} discovery-scan jobs`);
    return;
  }

  // Per-user trigger — delegate to discovery-scan by minting a scanRunId.
  const data = job.data as Extract<DiscoveryJobData, { userId: string }>;
  await enqueueDiscoveryScan({
    schemaVersion: 1,
    traceId: randomUUID(),
    userId: data.userId,
    productId: data.productId,
    platform: data.platform,
    scanRunId: `manual-${Date.now()}-${randomUUID().slice(0, 8)}`,
    trigger: 'manual',
  });
}
