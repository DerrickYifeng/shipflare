import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { channels, products, discoveryConfigs } from '@/lib/db/schema';
import { enqueueSearchSource, enqueueDiscoveryScan } from '@/lib/queue';
import { publishUserEvent } from '@/lib/redis';
import { getPlatformConfig, isPlatformAvailable } from '@/lib/platform-config';
import { isStopRequested } from '@/lib/automation-stop';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { DiscoveryScanJobData } from '@/lib/queue/types';
import { getTraceId, isFanoutJob } from '@/lib/queue/types';
import { recordPipelineEvent } from '@/lib/pipeline-events';

const baseLog = createLogger('worker:discovery-scan');

/**
 * Process a top-level discovery-scan job.
 *
 *  - `kind: 'fanout'`: cron entry fired every 4h. Iterates all distinct
 *    `(userId, platform)` pairs that have both a channel and a product, and
 *    enqueues a per-user `discovery-scan` job with `trigger: 'cron'`. Mirrors
 *    the fan-out shape from `discovery.ts` for consistency.
 *
 *    TODO(cost-signal): spec §1.7 wanted the cron cadence to depend on
 *    `users.lastActiveAt` (4h for active, 24h for inactive). That column
 *    doesn't exist yet; adding it is a separate schema change. Until we have
 *    cost signals that justify the extra query, all users with a channel +
 *    product get the same 4h cadence.
 *
 *  - `kind: 'user'` / legacy shape: real per-user scan. Reads the user's
 *    discovery config and fans out one `search-source` job per source.
 */
export async function processDiscoveryScan(job: Job<DiscoveryScanJobData>) {
  const log = loggerForJob(baseLog, job);
  const traceId = getTraceId(job.data, job.id);

  if (isFanoutJob(job.data)) {
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
          traceId,
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

  // Narrow to the per-user variant — `isFanoutJob` has already excluded the
  // fanout shape above. Mirrors the pattern `discovery.ts` uses for its shim.
  const data = job.data as Extract<DiscoveryScanJobData, { userId: string }>;
  const { userId, productId, platform, scanRunId } = data;

  // Synthetic `discovery_start` — there's no real discovery agent the
  // first-run progress bar can hook into between scout_complete and
  // content_start, so we emit a bracketing pair from this processor.
  await publishUserEvent(userId, 'agents', {
    type: 'discovery_start',
    scanRunId,
    platform,
  });

  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!product) throw new Error(`product ${productId} gone`);

  const [userConfig] = await db
    .select()
    .from(discoveryConfigs)
    .where(eq(discoveryConfigs.userId, userId))
    .limit(1);

  const config = getPlatformConfig(platform);
  const sources = userConfig?.customQueryTemplates?.length
    ? userConfig.customQueryTemplates
    : config.defaultSources;

  await publishUserEvent(userId, 'agents', {
    type: 'scan_started',
    scanRunId,
    sources,
    expectedCount: sources.length,
  });
  await recordPipelineEvent({
    userId,
    productId,
    stage: 'scan_started',
    metadata: { scanRunId, platform, sourcesCount: sources.length },
  });

  for (const source of sources) {
    await enqueueSearchSource({
      schemaVersion: 1,
      traceId,
      userId,
      productId,
      platform,
      source,
      scanRunId,
    });
    await publishUserEvent(userId, 'agents', {
      type: 'pipeline',
      pipeline: 'discovery',
      itemId: `${platform}:${source}`,
      state: 'queued',
    });
  }

  log.info(
    `discovery-scan fanned out ${sources.length} search-source jobs (scanRunId=${scanRunId})`,
  );

  // Close the synthetic discovery bracket. The per-source search jobs enqueue
  // content downstream; emitting here keeps the first-run progress bar moving
  // forward even when scouts return zero hits.
  await publishUserEvent(userId, 'agents', {
    type: 'discovery_complete',
    scanRunId,
    platform,
    sourcesCount: sources.length,
  });
}
