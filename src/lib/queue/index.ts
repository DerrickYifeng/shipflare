import { Queue, type JobsOptions } from 'bullmq';
import { getBullMQConnection } from '@/lib/redis';
import { createLogger } from '@/lib/logger';
import {
  discoveryJobSchema,
  contentJobSchema,
  reviewJobSchema,
  postingJobSchema,
  healthScoreJobSchema,
  dreamJobSchema,
  codeScanJobSchema,
  monitorJobSchema,
  contentCalendarJobSchema,
  engagementJobSchema,
  metricsJobSchema,
  analyticsJobSchema,
  todoSeedJobSchema,
  calibrationJobSchema,
} from './types';
import type {
  DiscoveryJobData,
  ContentJobData,
  ReviewJobData,
  PostingJobData,
  HealthScoreJobData,
  DreamJobData,
  CodeScanJobData,
  MonitorJobData,
  ContentCalendarJobData,
  EngagementJobData,
  MetricsJobData,
  AnalyticsJobData,
  TodoSeedJobData,
  CalibrationJobData,
} from './types';

const log = createLogger('lib:queue');

const connection = { connection: getBullMQConnection() };

/**
 * Default retention policy for all queues.
 * - completed jobs: 500 most recent, max 24h
 * - failed jobs: 2000 most recent, max 7 days
 * Without these, Redis memory grows unbounded.
 */
const DEFAULT_RETENTION = {
  removeOnComplete: { count: 500, age: 24 * 3600 },
  removeOnFail: { count: 2000, age: 7 * 24 * 3600 },
};

/**
 * Default retry policy for most queues. Posting queue overrides this
 * to 1 attempt to never risk duplicate posts.
 */
const DEFAULT_RETRY: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
};

const defaultJobOptions: JobsOptions = {
  ...DEFAULT_RETENTION,
  ...DEFAULT_RETRY,
};

export const discoveryQueue = new Queue<DiscoveryJobData>('discovery', {
  ...connection,
  defaultJobOptions,
});
export const contentQueue = new Queue<ContentJobData>('content', {
  ...connection,
  defaultJobOptions,
});
export const reviewQueue = new Queue<ReviewJobData>('review', {
  ...connection,
  defaultJobOptions,
});
export const postingQueue = new Queue<PostingJobData>('posting', {
  ...connection,
  defaultJobOptions: {
    ...DEFAULT_RETENTION,
    attempts: 1, // Never retry posts — avoid duplicate publishes
  },
});
export const healthScoreQueue = new Queue<HealthScoreJobData>('health-score', {
  ...connection,
  defaultJobOptions,
});
export const dreamQueue = new Queue<DreamJobData>('dream', {
  ...connection,
  defaultJobOptions,
});
export const codeScanQueue = new Queue<CodeScanJobData>('code-scan', {
  ...connection,
  defaultJobOptions,
});
export const monitorQueue = new Queue<MonitorJobData>('monitor', {
  ...connection,
  defaultJobOptions,
});
export const contentCalendarQueue = new Queue<ContentCalendarJobData>(
  'content-calendar',
  { ...connection, defaultJobOptions },
);
export const engagementQueue = new Queue<EngagementJobData>('engagement', {
  ...connection,
  defaultJobOptions,
});
export const metricsQueue = new Queue<MetricsJobData>('metrics', {
  ...connection,
  defaultJobOptions,
});
export const analyticsQueue = new Queue<AnalyticsJobData>('analytics', {
  ...connection,
  defaultJobOptions,
});

// Backward-compat aliases (will be removed after full migration)
export const xMonitorQueue = monitorQueue;
export const xContentCalendarQueue = contentCalendarQueue;
export const xEngagementQueue = engagementQueue;
export const xMetricsQueue = metricsQueue;
export const xAnalyticsQueue = analyticsQueue;

/**
 * Ensure every enqueued payload carries schemaVersion: 1 so consumers can
 * version-gate behaviour when we rev the contract.
 */
function withSchemaVersion<T extends { schemaVersion?: number }>(data: T): T {
  return { ...data, schemaVersion: 1 };
}

/** Best-effort label for log lines on discriminated-union payloads. */
function describePayload(p: unknown): string {
  if (!p || typeof p !== 'object') return 'unknown';
  const obj = p as Record<string, unknown>;
  if (obj.kind === 'fanout') return `fanout${obj.platform ? ` platform=${obj.platform}` : ''}`;
  const parts: string[] = [];
  if (typeof obj.userId === 'string') parts.push(`user=${obj.userId}`);
  if (typeof obj.platform === 'string') parts.push(`platform=${obj.platform}`);
  if (typeof obj.productId === 'string') parts.push(`product=${obj.productId}`);
  return parts.length ? parts.join(' ') : 'payload';
}

/**
 * Enqueue a discovery scan for a user's product across sources (subreddits or topics).
 */
export async function enqueueDiscovery(data: DiscoveryJobData): Promise<void> {
  const payload = discoveryJobSchema.parse(withSchemaVersion(data));
  log.debug(`Enqueued discovery (${describePayload(payload)})`);
  await discoveryQueue.add('scan', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

/**
 * Enqueue content generation for a discovered thread.
 */
export async function enqueueContent(data: ContentJobData): Promise<void> {
  const payload = contentJobSchema.parse(withSchemaVersion(data));
  log.debug(`Enqueued content for thread ${payload.threadId}`);
  await contentQueue.add('draft', payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
  });
}

/**
 * Enqueue review for a newly created draft.
 */
export async function enqueueReview(data: ReviewJobData): Promise<void> {
  const payload = reviewJobSchema.parse(withSchemaVersion(data));
  log.debug(`Enqueued review for draft ${payload.draftId}`);
  await reviewQueue.add('review', payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
  });
}

/**
 * Enqueue posting an approved draft with a random delay (0-30 min).
 * 0 retries: never risk duplicate posts.
 */
export async function enqueuePosting(data: PostingJobData): Promise<void> {
  const payload = postingJobSchema.parse(withSchemaVersion(data));
  const delayMs = Math.floor(Math.random() * 30 * 60 * 1000);
  log.debug(`Enqueued posting for draft ${payload.draftId} (delay ${Math.round(delayMs / 1000)}s)`);
  await postingQueue.add('post', payload, {
    attempts: 1, // No retries
    delay: delayMs,
  });
}

/**
 * Enqueue health score recalculation.
 */
export async function enqueueHealthScore(
  data: HealthScoreJobData,
): Promise<void> {
  const payload = healthScoreJobSchema.parse(withSchemaVersion(data));
  log.debug(`Enqueued health-score for user ${payload.userId}`);
  await healthScoreQueue.add('calculate', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}

/**
 * Enqueue memory distillation for a product.
 * Uses jobId dedup (one per product) + 60s debounce delay
 * so multiple agent runs batch their logs before distilling.
 */
export async function enqueueDream(data: DreamJobData): Promise<void> {
  const payload = dreamJobSchema.parse(withSchemaVersion(data));
  log.debug(`Enqueued dream for product ${payload.productId}`);
  await dreamQueue.add('distill', payload, {
    jobId: `distill-${payload.productId}`,
    delay: 60_000,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

/**
 * Enqueue a code scan for a GitHub repo.
 * Runs in worker: clone → scan → save snapshot.
 */
export async function enqueueCodeScan(data: CodeScanJobData): Promise<string> {
  const payload = codeScanJobSchema.parse(withSchemaVersion(data));
  const jobId = `code-scan-${payload.userId}-${Date.now()}`;
  log.debug(`Enqueued code-scan for ${payload.repoFullName}`);
  await codeScanQueue.add('scan', payload, {
    jobId,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  });
  return jobId;
}

// ----------------------------------------------------------------
//  Growth queues (platform-aware)
// ----------------------------------------------------------------

/**
 * Enqueue monitor scan: poll target accounts for new posts.
 */
export async function enqueueMonitor(data: MonitorJobData): Promise<void> {
  const payload = monitorJobSchema.parse(withSchemaVersion(data));
  log.debug(`Enqueued monitor (${describePayload(payload)})`);
  await monitorQueue.add('scan', payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

/**
 * Enqueue content calendar processing: generate drafts for scheduled posts.
 */
export async function enqueueContentCalendar(
  data: ContentCalendarJobData,
): Promise<void> {
  const payload = contentCalendarJobSchema.parse(withSchemaVersion(data));
  log.debug(`Enqueued content-calendar (${describePayload(payload)})`);
  await contentCalendarQueue.add('process', payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
  });
}

/**
 * Enqueue engagement monitoring for a recently posted piece of content.
 * Accepts a delay (ms) for scheduling checks at +15/30/60 minutes.
 */
export async function enqueueEngagement(
  data: EngagementJobData,
  delayMs?: number,
): Promise<void> {
  const payload = engagementJobSchema.parse(withSchemaVersion(data));
  log.debug(
    `Enqueued ${payload.platform} engagement for content ${payload.contentId}` +
      (delayMs ? ` (delay ${Math.round(delayMs / 1000)}s)` : ''),
  );
  // engagement schema isn't a union — payload.contentId / payload.platform safe
  await engagementQueue.add('monitor', payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
    ...(delayMs ? { delay: delayMs } : {}),
  });
}

/**
 * Enqueue metrics collection: batch-fetch post performance data.
 */
export async function enqueueMetrics(data: MetricsJobData): Promise<void> {
  const payload = metricsJobSchema.parse(withSchemaVersion(data));
  log.debug(`Enqueued metrics (${describePayload(payload)})`);
  await metricsQueue.add('collect', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}

/**
 * Enqueue analytics computation: aggregate metrics into insights.
 */
export async function enqueueAnalytics(data: AnalyticsJobData): Promise<void> {
  const payload = analyticsJobSchema.parse(withSchemaVersion(data));
  log.debug(`Enqueued analytics (${describePayload(payload)})`);
  await analyticsQueue.add('compute', payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
  });
}

// Backward-compat function aliases (will be removed after full migration)
export const enqueueXMonitor = enqueueMonitor;
export const enqueueXContentCalendar = enqueueContentCalendar;
export const enqueueXEngagement = enqueueEngagement;
export const enqueueXMetrics = enqueueMetrics;
export const enqueueXAnalytics = enqueueAnalytics;

// ----------------------------------------------------------------
//  Today queue
// ----------------------------------------------------------------

export const todoSeedQueue = new Queue<TodoSeedJobData>('todo-seed', {
  ...connection,
  defaultJobOptions,
});
export const calibrationQueue = new Queue<CalibrationJobData>('calibration', {
  ...connection,
  defaultJobOptions: {
    ...DEFAULT_RETENTION,
    attempts: 1, // Calibration checkpoints progress to DB; never auto-retry
  },
});

/**
 * Enqueue todo seed: populate daily todo items for a user.
 */
export async function enqueueTodoSeed(data: TodoSeedJobData): Promise<void> {
  const payload = todoSeedJobSchema.parse(withSchemaVersion(data));
  log.debug(`Enqueued todo-seed (${describePayload(payload)})`);
  await todoSeedQueue.add('seed', payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
  });
}

/**
 * Enqueue discovery calibration: run the optimize loop for a user's product.
 * No retries — partial progress is checkpointed to DB after each round.
 */
export async function enqueueCalibration(
  data: CalibrationJobData,
): Promise<void> {
  const payload = calibrationJobSchema.parse(withSchemaVersion(data));
  log.debug(
    `Enqueued calibration for product ${payload.productId} (maxRounds=${payload.maxRounds ?? 10})`,
  );
  await calibrationQueue.add('calibrate', payload, {
    attempts: 1,
  });
}
