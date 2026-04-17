import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { products, channels, discoveryConfigs } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { createPlatformDeps } from '@/lib/platform-deps';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { discoveryOutputSchema } from '@/agents/schemas';
import type { DiscoveryOutput } from '@/agents/schemas';
import { publishEvent } from '@/lib/redis';
import { join } from 'path';
import type { CalibrationJobData } from '@/lib/queue/types';
import { getTraceId } from '@/lib/queue/types';
import { createLogger, loggerForJob, type Logger } from '@/lib/logger';
import { isPlatformAvailable, getPlatformConfig } from '@/lib/platform-config';
import { judgeThreadsBatch } from '@/lib/discovery/judge';
import type { ScoredThread } from '@/lib/discovery/judge';
import { runOptimizer } from '@/lib/discovery/optimizer';
import { applyOptimization } from '@/lib/discovery/apply-optimization';
import type { UsageSummary } from '@/core/types';

const baseLog = createLogger('worker:calibration');

const discoverySkill = loadSkill(
  join(process.cwd(), 'src/skills/discovery'),
);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ROUNDS = 10;
const TARGET_PRECISION = 0.80;
const SCORE_THRESHOLD = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CalibrationLogEntry {
  round: number;
  precision: number | null;
  evaluated: number;
  changes: string;
  appliedChanges?: string;
  costUsd?: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

export async function processCalibration(job: Job<CalibrationJobData>) {
  const log = loggerForJob(baseLog, job);
  const traceId = getTraceId(job.data, job.id);
  const { userId, productId, maxRounds = DEFAULT_MAX_ROUNDS } = job.data;

  log.info(`Starting calibration for product ${productId}, user ${userId}, maxRounds=${maxRounds}`);

  // Load product
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!product) {
    throw new Error(`Product not found: ${productId}`);
  }

  // Find connected platforms
  const userChannels = await db
    .select({ platform: channels.platform })
    .from(channels)
    .where(eq(channels.userId, userId));

  const platforms = [...new Set(userChannels.map((c) => c.platform))].filter(
    isPlatformAvailable,
  );

  if (platforms.length === 0) {
    log.info('No connected platforms, skipping calibration');
    return;
  }

  for (const platform of platforms) {
    await calibratePlatform(userId, product, platform, maxRounds, log, traceId);
  }

  // Publish completion event
  await publishEvent(`shipflare:events:${userId}`, {
    type: 'calibration_complete',
    productId,
  });
}

// ---------------------------------------------------------------------------
// Per-platform calibration loop
// ---------------------------------------------------------------------------

async function calibratePlatform(
  userId: string,
  product: typeof products.$inferSelect,
  platform: string,
  maxRounds: number,
  log: Logger,
  traceId: string,
) {
  // Load or create config
  let [config] = await db
    .select()
    .from(discoveryConfigs)
    .where(
      and(
        eq(discoveryConfigs.userId, userId),
        eq(discoveryConfigs.platform, platform),
      ),
    )
    .limit(1);

  if (!config) {
    const [created] = await db
      .insert(discoveryConfigs)
      .values({ userId, platform, calibrationStatus: 'pending' })
      .returning();
    config = created;
  }

  // Skip if already calibrated
  if (config.calibrationStatus === 'completed') {
    log.info(`${platform} already calibrated for user ${userId}, skipping`);
    return;
  }

  // Mark as running
  await db
    .update(discoveryConfigs)
    .set({ calibrationStatus: 'running', updatedAt: new Date() })
    .where(eq(discoveryConfigs.id, config.id));

  const calibrationLog: CalibrationLogEntry[] =
    (config.calibrationLog as CalibrationLogEntry[] | null) ?? [];

  // Resume from last completed round (crash recovery)
  const startRound = config.calibrationRound;

  for (let round = startRound; round < maxRounds; round++) {
    log.info(
      `Calibration round ${round + 1}/${maxRounds} for ${platform}, user ${userId}`,
    );

    // Publish progress
    await publishEvent(`shipflare:events:${userId}`, {
      type: 'calibration_progress',
      platform,
      round: round + 1,
      maxRounds,
    });

    let roundCostUsd = 0;

    // ── Step 1: Run discovery with current config ──
    const discoveryResult = await runDiscoveryWithConfig(
      product,
      platform,
      userId,
      config,
      traceId,
    );
    roundCostUsd += discoveryResult.usage.costUsd;

    // ── Step 2: Filter threads above threshold ──
    const threadsAboveThreshold = discoveryResult.threads.filter(
      (t) => (t.relevanceScore ?? 0) > SCORE_THRESHOLD,
    );

    if (threadsAboveThreshold.length === 0) {
      log.info(
        `No threads above threshold ${SCORE_THRESHOLD}, skipping round`,
      );
      calibrationLog.push({
        round: round + 1,
        precision: null,
        evaluated: 0,
        changes: 'No threads to evaluate',
        costUsd: roundCostUsd,
        timestamp: new Date().toISOString(),
      });
      // Checkpoint
      await db
        .update(discoveryConfigs)
        .set({
          calibrationRound: round + 1,
          calibrationLog,
          updatedAt: new Date(),
        })
        .where(eq(discoveryConfigs.id, config.id));
      continue;
    }

    // ── Step 3: AI Judge ──
    const scoredThreads: ScoredThread[] = threadsAboveThreshold.map((t) => ({
      id: t.id,
      title: t.title,
      community: t.community,
      url: t.url,
      relevanceScore: t.relevanceScore ?? 0,
      scores: t.scores,
      reason: t.reason,
    }));

    const { judgments, usage: judgeUsage } = await judgeThreadsBatch(
      {
        name: product.name,
        description: product.description,
        valueProp: product.valueProp,
      },
      scoredThreads,
      platform,
    );
    roundCostUsd += judgeUsage.costUsd;

    if (judgments.length === 0) {
      log.info('Judge returned no judgments, skipping round');
      calibrationLog.push({
        round: round + 1,
        precision: null,
        evaluated: 0,
        changes: 'Judge returned no judgments',
        costUsd: roundCostUsd,
        timestamp: new Date().toISOString(),
      });
      await db
        .update(discoveryConfigs)
        .set({
          calibrationRound: round + 1,
          calibrationLog,
          updatedAt: new Date(),
        })
        .where(eq(discoveryConfigs.id, config.id));
      continue;
    }

    const potentialUsers = judgments.filter((j) => j.isPotentialUser);
    const precision = potentialUsers.length / judgments.length;

    log.info(
      `Round ${round + 1}: precision=${(precision * 100).toFixed(0)}% (${potentialUsers.length}/${judgments.length})`,
    );

    // ── Step 4: Check if target reached ──
    if (precision >= TARGET_PRECISION) {
      calibrationLog.push({
        round: round + 1,
        precision,
        evaluated: judgments.length,
        changes: 'Target reached',
        costUsd: roundCostUsd,
        timestamp: new Date().toISOString(),
      });

      await db
        .update(discoveryConfigs)
        .set({
          calibrationStatus: 'completed',
          calibrationRound: round + 1,
          calibrationPrecision: precision,
          calibrationLog,
          lastOptimizedAt: new Date(),
          precisionAtOptimization: precision,
          updatedAt: new Date(),
        })
        .where(eq(discoveryConfigs.id, config.id));

      log.info(
        `Calibration complete for ${platform}: precision=${(precision * 100).toFixed(0)}% after ${round + 1} rounds`,
      );
      return;
    }

    // ── Step 5: Optimize ──
    const falsePositives = judgments
      .filter((j) => !j.isPotentialUser)
      .map((j) => ({ ...j, judgeReason: j.reason }));

    const truePositives = judgments
      .filter((j) => j.isPotentialUser)
      .map((j) => ({ ...j, judgeReason: j.reason }));

    const { result: optimizerResult, usage: optimizerUsage } =
      await runOptimizer({
        product: {
          name: product.name,
          description: product.description,
          valueProp: product.valueProp,
        },
        platform,
        currentConfig: {
          weights: {
            relevance: config.weightRelevance,
            intent: config.weightIntent,
            exposure: config.weightExposure,
            freshness: config.weightFreshness,
            engagement: config.weightEngagement,
          },
          intentGate: config.intentGate,
          relevanceGate: config.relevanceGate,
          gateCap: config.gateCap,
          strategyRules: config.strategyRules,
          customLowRelevancePatterns: config.customLowRelevancePatterns,
          customPainPhrases: config.customPainPhrases ?? [],
          customQueryTemplates: config.customQueryTemplates ?? [],
        },
        falsePositives,
        truePositives,
        precision,
        round: round + 1,
        previousLog: calibrationLog,
      });
    roundCostUsd += optimizerUsage.costUsd;

    // ── Step 6: Apply edits ──
    const appliedChanges = await applyOptimization(
      config.id,
      optimizerResult,
    );

    calibrationLog.push({
      round: round + 1,
      precision,
      evaluated: judgments.length,
      changes: optimizerResult.analysis,
      appliedChanges,
      costUsd: roundCostUsd,
      timestamp: new Date().toISOString(),
    });

    // Checkpoint
    await db
      .update(discoveryConfigs)
      .set({
        calibrationRound: round + 1,
        calibrationLog,
        updatedAt: new Date(),
      })
      .where(eq(discoveryConfigs.id, config.id));

    // Reload config for next round (it was just updated by applyOptimization)
    const [reloaded] = await db
      .select()
      .from(discoveryConfigs)
      .where(eq(discoveryConfigs.id, config.id))
      .limit(1);
    config = reloaded;
  }

  // Exhausted all rounds — save best effort
  if (config.calibrationStatus !== 'completed') {
    const lastPrecision = calibrationLog.at(-1)?.precision ?? null;
    await db
      .update(discoveryConfigs)
      .set({
        calibrationStatus: 'completed',
        calibrationPrecision: lastPrecision,
        calibrationLog,
        lastOptimizedAt: new Date(),
        precisionAtOptimization: lastPrecision,
        updatedAt: new Date(),
      })
      .where(eq(discoveryConfigs.id, config.id));

    log.info(
      `Calibration finished for ${platform} after ${maxRounds} rounds (best-effort, precision=${lastPrecision != null ? (lastPrecision * 100).toFixed(0) + '%' : 'unknown'})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Run discovery with per-user config injected
// ---------------------------------------------------------------------------

interface DiscoveryWithConfigResult {
  threads: DiscoveryOutput['threads'];
  usage: UsageSummary;
}

async function runDiscoveryWithConfig(
  product: typeof products.$inferSelect,
  platform: string,
  userId: string,
  config: typeof discoveryConfigs.$inferSelect,
  traceId: string,
): Promise<DiscoveryWithConfigResult> {
  const platformConfig = getPlatformConfig(platform);
  const deps = await createPlatformDeps(platform, userId);
  const sources = platformConfig.defaultSources;

  // Build input with per-user config injected
  const input: Record<string, unknown> = {
    productName: product.name,
    productDescription: product.description,
    keywords: product.keywords,
    valueProp: product.valueProp,
    sources,
    platform,
  };

  // Inject per-user config overrides
  if (config.calibrationStatus === 'running' || config.calibrationStatus === 'completed') {
    input.scoringConfig = {
      weights: {
        relevance: config.weightRelevance,
        intent: config.weightIntent,
        exposure: config.weightExposure,
        freshness: config.weightFreshness,
        engagement: config.weightEngagement,
      },
      intentGate: config.intentGate,
      relevanceGate: config.relevanceGate,
      gateCap: config.gateCap,
    };
    if (config.customPainPhrases && config.customPainPhrases.length > 0) {
      input.customPainPhrases = config.customPainPhrases;
    }
    if (config.customQueryTemplates && config.customQueryTemplates.length > 0) {
      input.customQueryTemplates = config.customQueryTemplates;
    }
    if (config.strategyRules) {
      input.additionalRules = config.strategyRules;
    }
    if (config.customLowRelevancePatterns) {
      input.additionalLowRelevancePatterns = config.customLowRelevancePatterns;
    }
  }

  const result = await runSkill<DiscoveryOutput>({
    skill: discoverySkill,
    input,
    deps,
    outputSchema: discoveryOutputSchema,
    runId: traceId,
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

  return { threads: allThreads, usage: result.usage };
}
