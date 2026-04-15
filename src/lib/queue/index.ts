import { Queue } from 'bullmq';
import { getRedis } from '@/lib/redis';
import { createLogger } from '@/lib/logger';
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

const connection = { connection: getRedis() };

export const discoveryQueue = new Queue<DiscoveryJobData>(
  'discovery',
  connection,
);
export const contentQueue = new Queue<ContentJobData>('content', connection);
export const reviewQueue = new Queue<ReviewJobData>('review', connection);
export const postingQueue = new Queue<PostingJobData>('posting', connection);
export const healthScoreQueue = new Queue<HealthScoreJobData>(
  'health-score',
  connection,
);
export const dreamQueue = new Queue<DreamJobData>('dream', connection);
export const codeScanQueue = new Queue<CodeScanJobData>('code-scan', connection);
export const monitorQueue = new Queue<MonitorJobData>('monitor', connection);
export const contentCalendarQueue = new Queue<ContentCalendarJobData>('content-calendar', connection);
export const engagementQueue = new Queue<EngagementJobData>('engagement', connection);
export const metricsQueue = new Queue<MetricsJobData>('metrics', connection);
export const analyticsQueue = new Queue<AnalyticsJobData>('analytics', connection);

// Backward-compat aliases (will be removed after full migration)
export const xMonitorQueue = monitorQueue;
export const xContentCalendarQueue = contentCalendarQueue;
export const xEngagementQueue = engagementQueue;
export const xMetricsQueue = metricsQueue;
export const xAnalyticsQueue = analyticsQueue;

/**
 * Enqueue a discovery scan for a user's product across sources (subreddits or topics).
 */
export async function enqueueDiscovery(data: DiscoveryJobData): Promise<void> {
  log.debug(`Enqueued ${data.platform} discovery for product ${data.productId}`);
  await discoveryQueue.add('scan', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

/**
 * Enqueue content generation for a discovered thread.
 */
export async function enqueueContent(data: ContentJobData): Promise<void> {
  log.debug(`Enqueued content for thread ${data.threadId}`);
  await contentQueue.add('draft', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
  });
}

/**
 * Enqueue review for a newly created draft.
 */
export async function enqueueReview(data: ReviewJobData): Promise<void> {
  log.debug(`Enqueued review for draft ${data.draftId}`);
  await reviewQueue.add('review', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
  });
}

/**
 * Enqueue posting an approved draft with a random delay (0-30 min).
 * 0 retries: never risk duplicate posts.
 */
export async function enqueuePosting(data: PostingJobData): Promise<void> {
  const delayMs = Math.floor(Math.random() * 30 * 60 * 1000);
  log.debug(`Enqueued posting for draft ${data.draftId} (delay ${Math.round(delayMs / 1000)}s)`);
  await postingQueue.add('post', data, {
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
  log.debug(`Enqueued health-score for user ${data.userId}`);
  await healthScoreQueue.add('calculate', data, {
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
  log.debug(`Enqueued dream for product ${data.productId}`);
  await dreamQueue.add('distill', data, {
    jobId: `distill-${data.productId}`,
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
  const jobId = `code-scan-${data.userId}-${Date.now()}`;
  log.debug(`Enqueued code-scan for ${data.repoFullName}`);
  await codeScanQueue.add('scan', data, {
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
  log.debug(`Enqueued ${data.platform} monitor for user ${data.userId}`);
  await monitorQueue.add('scan', data, {
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
  log.debug(`Enqueued ${data.platform} content-calendar for user ${data.userId}`);
  await contentCalendarQueue.add('process', data, {
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
  log.debug(
    `Enqueued ${data.platform} engagement for content ${data.contentId}` +
      (delayMs ? ` (delay ${Math.round(delayMs / 1000)}s)` : ''),
  );
  await engagementQueue.add('monitor', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
    ...(delayMs ? { delay: delayMs } : {}),
  });
}

/**
 * Enqueue metrics collection: batch-fetch post performance data.
 */
export async function enqueueMetrics(data: MetricsJobData): Promise<void> {
  log.debug(`Enqueued ${data.platform} metrics for user ${data.userId}`);
  await metricsQueue.add('collect', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}

/**
 * Enqueue analytics computation: aggregate metrics into insights.
 */
export async function enqueueAnalytics(data: AnalyticsJobData): Promise<void> {
  log.debug(`Enqueued ${data.platform} analytics for user ${data.userId}`);
  await analyticsQueue.add('compute', data, {
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

export const todoSeedQueue = new Queue<TodoSeedJobData>('todo-seed', connection);
export const calibrationQueue = new Queue<CalibrationJobData>(
  'calibration',
  connection,
);

/**
 * Enqueue todo seed: populate daily todo items for a user.
 */
export async function enqueueTodoSeed(data: TodoSeedJobData): Promise<void> {
  log.debug(`Enqueued todo-seed for user ${data.userId}`);
  await todoSeedQueue.add('seed', data, {
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
  log.debug(
    `Enqueued calibration for product ${data.productId} (maxRounds=${data.maxRounds ?? 10})`,
  );
  await calibrationQueue.add('calibrate', data, {
    attempts: 1,
  });
}
