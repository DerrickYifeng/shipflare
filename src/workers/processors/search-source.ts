import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { join } from 'path';
import { db } from '@/lib/db';
import { products, threads, discoveryConfigs } from '@/lib/db/schema';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { discoveryOutputSchema, type DiscoveryOutput } from '@/agents/schemas';
import { enqueueContent } from '@/lib/queue';
import { publishUserEvent } from '@/lib/redis';
import { createPlatformDeps } from '@/lib/platform-deps';
import { MemoryStore } from '@/memory/store';
import { buildMemoryPrompt } from '@/memory/prompt-builder';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { SearchSourceJobData } from '@/lib/queue/types';
import { getTraceId } from '@/lib/queue/types';
import { recordPipelineEvent } from '@/lib/pipeline-events';

const baseLog = createLogger('worker:search-source');
const discoverySkill = loadSkill(join(process.cwd(), 'src/skills/discovery'));

export async function processSearchSource(job: Job<SearchSourceJobData>) {
  const traceId = getTraceId(job.data, job.id);
  const log = loggerForJob(baseLog, job);
  const { userId, productId, platform, source, scanRunId } = job.data;

  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!product) throw new Error(`product ${productId} gone`);

  const [userConfig] = await db
    .select()
    .from(discoveryConfigs)
    .where(
      and(
        eq(discoveryConfigs.userId, userId),
        eq(discoveryConfigs.platform, platform),
      ),
    )
    .limit(1);

  const deps = await createPlatformDeps(platform, userId);
  const memoryStore = new MemoryStore(userId, productId);
  const memoryPrompt = await buildMemoryPrompt(memoryStore);

  await publishUserEvent(userId, 'agents', {
    type: 'pipeline',
    pipeline: 'discovery',
    itemId: `${platform}:${source}`,
    state: 'searching',
  });

  const input: Record<string, unknown> = {
    productName: product.name,
    productDescription: product.description,
    keywords: product.keywords,
    valueProp: product.valueProp ?? '',
    source,
    platform,
  };
  if (userConfig?.calibrationStatus === 'completed') {
    input.scoringConfig = {
      weights: {
        relevance: userConfig.weightRelevance,
        intent: userConfig.weightIntent,
        exposure: userConfig.weightExposure,
        freshness: userConfig.weightFreshness,
        engagement: userConfig.weightEngagement,
      },
      intentGate: userConfig.intentGate,
      relevanceGate: userConfig.relevanceGate,
      gateCap: userConfig.gateCap,
    };
    if (userConfig.customPainPhrases && userConfig.customPainPhrases.length > 0) {
      input.customPainPhrases = userConfig.customPainPhrases;
    }
    if (userConfig.customQueryTemplates && userConfig.customQueryTemplates.length > 0) {
      input.customQueryTemplates = userConfig.customQueryTemplates;
    }
    if (userConfig.strategyRules) {
      input.additionalRules = userConfig.strategyRules;
    }
  }

  const res = await runSkill<DiscoveryOutput>({
    skill: discoverySkill,
    input,
    deps,
    memoryPrompt: memoryPrompt || undefined,
    outputSchema: discoveryOutputSchema,
    runId: traceId,
  });

  const gate = userConfig?.enqueueThreshold ?? 0.7;
  const allThreads = res.results.flatMap((r) => r.threads);

  const candidates = allThreads
    .map((t) => {
      const relevanceScore = t.relevanceScore != null
        ? t.relevanceScore / 100
        : ((t.relevance ?? 0) + (t.intent ?? 0)) / 2;
      return { t, relevanceScore };
    })
    .filter((c) => c.relevanceScore >= 0.3);

  const rows = candidates.map((c) => ({
    userId,
    externalId: c.t.id,
    platform,
    community: c.t.community,
    title: c.t.title,
    url: c.t.url,
    relevanceScore: c.relevanceScore,
    sourceJobId: job.id ?? null,
    state: 'queued' as const,
  }));
  const shouldEnqueue = new Set(
    candidates.filter((c) => c.relevanceScore >= gate).map((c) => c.t.id),
  );

  let inserted: Array<{ id: string; externalId: string }> = [];
  if (rows.length > 0) {
    inserted = await db
      .insert(threads)
      .values(rows)
      .onConflictDoNothing({ target: [threads.userId, threads.platform, threads.externalId] })
      .returning({ id: threads.id, externalId: threads.externalId });
  }

  for (const row of inserted) {
    if (!shouldEnqueue.has(row.externalId)) continue;
    await enqueueContent({ userId, threadId: row.id, productId, traceId });
  }

  await publishUserEvent(userId, 'agents', {
    type: 'pipeline',
    pipeline: 'discovery',
    itemId: `${platform}:${source}`,
    state: 'searched',
    data: { found: rows.length, aboveGate: inserted.length, source, platform },
  });
  await recordPipelineEvent({
    userId,
    productId,
    stage: 'source_searched',
    cost: res.usage.costUsd,
    metadata: { platform, source, scanRunId, found: rows.length },
  });

  log.info(
    `search-source ${platform}:${source} — found ${rows.length}, gated ${inserted.length}`,
  );
}
