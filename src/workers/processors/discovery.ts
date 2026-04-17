import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { products, threads, activityEvents, discoveryConfigs } from '@/lib/db/schema';
import { channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { createPlatformDeps } from '@/lib/platform-deps';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { discoveryOutputSchema } from '@/agents/schemas';
import type { DiscoveryOutput } from '@/agents/schemas';
import { enqueueContent, enqueueDream, enqueueDiscovery } from '@/lib/queue';
import { publishEvent } from '@/lib/redis';
import { join } from 'path';
import type { DiscoveryJobData } from '@/lib/queue/types';
import { isFanoutJob } from '@/lib/queue/types';
import { createLogger } from '@/lib/logger';
import { MemoryStore } from '@/memory/store';
import { AgentDream } from '@/memory/dream';
import { buildMemoryPrompt } from '@/memory/prompt-builder';
import { isPlatformAvailable, getPlatformConfig } from '@/lib/platform-config';

const log = createLogger('worker:discovery');

const discoverySkill = loadSkill(
  join(process.cwd(), 'src/skills/discovery'),
);

export async function processDiscovery(job: Job<DiscoveryJobData>) {
  // Cron fan-out: enqueue per-user discovery jobs so downstream worker
  // concurrency actually parallelizes across users. Tolerates both the new
  // discriminated-union payload (`kind: 'fanout'`) and the legacy sentinel
  // (`userId === '__all__'`) for in-flight jobs during rollout.
  if (isFanoutJob(job.data)) {
    const allChannels = await db
      .select({ userId: channels.userId, platform: channels.platform })
      .from(channels);

    const userPlatforms = new Map<string, Set<string>>();
    for (const ch of allChannels) {
      if (!userPlatforms.has(ch.userId)) userPlatforms.set(ch.userId, new Set());
      userPlatforms.get(ch.userId)!.add(ch.platform);
    }

    log.info(`Cron discovery fan-out: ${userPlatforms.size} users with channels`);

    let enqueued = 0;
    for (const [uid, platformSet] of userPlatforms) {
      const [product] = await db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.userId, uid))
        .limit(1);
      if (!product) continue;

      for (const platformId of platformSet) {
        if (!isPlatformAvailable(platformId)) continue;
        const config = getPlatformConfig(platformId);
        // Fire per-user enqueue; BullMQ concurrency handles actual parallelism.
        await enqueueDiscovery({
          userId: uid,
          productId: product.id,
          sources: config.defaultSources,
          platform: platformId,
        });
        enqueued++;
      }
    }
    log.info(`Cron discovery fan-out enqueued ${enqueued} per-user jobs`);
    return;
  }

  // Per-user payload — processor does the actual work.
  const data = job.data as Extract<DiscoveryJobData, { userId: string }>;
  const { userId, productId, sources, platform } = data;

  log.info(`Starting ${platform} discovery for product ${productId}, ${sources.length} sources`);

  // Load product
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!product) throw new Error(`Product not found: ${productId}`);

  // Initialize platform-specific client
  const deps = await createPlatformDeps(platform, userId);

  // Load memory context
  const memoryStore = new MemoryStore(productId);
  const dream = new AgentDream(memoryStore);
  const memoryPrompt = await buildMemoryPrompt(memoryStore);

  // Load per-user discovery config (if calibrated)
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

  // Build skill input with per-user config injected
  const skillInput: Record<string, unknown> = {
    productName: product.name,
    productDescription: product.description,
    keywords: product.keywords,
    valueProp: product.valueProp,
    sources,
    platform,
  };

  if (userConfig?.calibrationStatus === 'completed') {
    skillInput.scoringConfig = {
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
      skillInput.customPainPhrases = userConfig.customPainPhrases;
    }
    if (userConfig.customQueryTemplates && userConfig.customQueryTemplates.length > 0) {
      skillInput.customQueryTemplates = userConfig.customQueryTemplates;
    }
    if (userConfig.strategyRules) {
      skillInput.additionalRules = userConfig.strategyRules;
    }
    if (userConfig.customLowRelevancePatterns) {
      skillInput.additionalLowRelevancePatterns = userConfig.customLowRelevancePatterns;
    }
  }

  // Run discovery skill (fan-out across sources, cache-safe)
  const result = await runSkill<DiscoveryOutput>({
    skill: discoverySkill,
    input: skillInput,
    deps,
    memoryPrompt: memoryPrompt || undefined,
    outputSchema: discoveryOutputSchema,
  });

  // Merge and deduplicate threads
  const seenIds = new Set<string>();
  const allThreads: DiscoveryOutput['threads'] = [];

  for (const discovery of result.results) {
    for (const thread of discovery.threads) {
      if (seenIds.has(thread.id)) continue;
      seenIds.add(thread.id);
      allThreads.push(thread);
    }
  }

  log.info(`${platform} discovery found ${allThreads.length} results across ${sources.length} sources, cost $${result.usage.costUsd.toFixed(4)}`);

  for (const err of result.errors) {
    log.warn(`Agent failed for "${err.label}": ${err.error}`);
  }

  // Persist threads
  let newThreadCount = 0;
  for (const thread of allThreads) {
    const existing = await db
      .select()
      .from(threads)
      .where(
        and(eq(threads.userId, userId), eq(threads.externalId, thread.id)),
      )
      .limit(1);

    if (existing.length > 0) continue;

    const relevanceScore = thread.relevanceScore != null
      ? thread.relevanceScore / 100
      : ((thread.relevance ?? 0) + (thread.intent ?? 0)) / 2;

    // Skip low-relevance threads to keep the DB clean
    if (relevanceScore < 0.3) continue;

    const [inserted] = await db
      .insert(threads)
      .values({
        userId,
        externalId: thread.id,
        platform,
        community: thread.community,
        title: thread.title,
        url: thread.url,
        relevanceScore,
      })
      .returning();

    newThreadCount++;

    // Auto-enqueue content for high-relevance threads
    const enqueueThreshold = userConfig?.enqueueThreshold ?? 0.7;
    if (relevanceScore >= enqueueThreshold && inserted) {
      log.debug(`Auto-enqueuing content for ${platform} thread ${inserted.id} (relevance ${relevanceScore.toFixed(2)})`);
      await enqueueContent({
        userId,
        threadId: inserted.id,
        productId,
      });
    }
  }

  // Log activity
  await db.insert(activityEvents).values({
    userId,
    eventType: 'discovery_scan',
    metadataJson: {
      platform,
      sources,
      resultsFound: allThreads.length,
      newResults: newThreadCount,
      cost: result.usage.costUsd,
    },
  });

  // Publish SSE event
  await publishEvent(`shipflare:events:${userId}`, {
    type: 'agent_complete',
    agentName: 'scout',
    platform,
    stats: { resultsFound: allThreads.length, newResults: newThreadCount },
    cost: result.usage.costUsd,
  });

  // Memory: log insights from this discovery run
  const topSources = sources
    .map((source) => {
      const count = allThreads.filter((t) => t.community === source).length;
      return { source, count };
    })
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count);

  if (topSources.length > 0) {
    const prefix = platform === 'reddit' ? 'r/' : '';
    const summary = topSources.map((s) => `${prefix}${s.source}: ${s.count} results`).join(', ');
    await dream.logInsight(`${platform} discovery found ${allThreads.length} results (${newThreadCount} new). ${summary}`);
  }

  for (const err of result.errors) {
    await dream.logInsight(`Discovery agent failed for "${err.label}" (${platform}): ${err.error}`);
  }

  // Check if distillation should be triggered
  if (await dream.shouldDistill()) {
    await enqueueDream({ productId });
  }
}
