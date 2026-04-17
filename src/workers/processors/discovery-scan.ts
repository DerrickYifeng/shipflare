import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { products, discoveryConfigs } from '@/lib/db/schema';
import { enqueueSearchSource } from '@/lib/queue';
import { publishUserEvent } from '@/lib/redis';
import { getPlatformConfig } from '@/lib/platform-config';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { DiscoveryScanJobData } from '@/lib/queue/types';
import { getTraceId } from '@/lib/queue/types';
import { recordPipelineEvent } from '@/lib/pipeline-events';

const baseLog = createLogger('worker:discovery-scan');

export async function processDiscoveryScan(job: Job<DiscoveryScanJobData>) {
  const traceId = getTraceId(job.data, job.id);
  const log = loggerForJob(baseLog, job);
  const { userId, productId, platform, scanRunId } = job.data;

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
}
