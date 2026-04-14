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
  XMonitorJobData,
  XContentCalendarJobData,
  XEngagementJobData,
  XMetricsJobData,
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
export const xMonitorQueue = new Queue<XMonitorJobData>('x-monitor', connection);
export const xContentCalendarQueue = new Queue<XContentCalendarJobData>('x-content-calendar', connection);
export const xEngagementQueue = new Queue<XEngagementJobData>('x-engagement', connection);
export const xMetricsQueue = new Queue<XMetricsJobData>('x-metrics', connection);

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
//  X Growth queues
// ----------------------------------------------------------------

/**
 * Enqueue X monitor scan: poll target accounts for new tweets.
 */
export async function enqueueXMonitor(data: XMonitorJobData): Promise<void> {
  log.debug(`Enqueued x-monitor for user ${data.userId}`);
  await xMonitorQueue.add('scan', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

/**
 * Enqueue X content calendar processing: generate drafts for scheduled posts.
 */
export async function enqueueXContentCalendar(
  data: XContentCalendarJobData,
): Promise<void> {
  log.debug(`Enqueued x-content-calendar for user ${data.userId}`);
  await xContentCalendarQueue.add('process', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
  });
}

/**
 * Enqueue X engagement monitoring for a recently posted tweet.
 * Accepts a delay (ms) for scheduling checks at +15/30/60 minutes.
 */
export async function enqueueXEngagement(
  data: XEngagementJobData,
  delayMs?: number,
): Promise<void> {
  log.debug(
    `Enqueued x-engagement for tweet ${data.tweetId}` +
      (delayMs ? ` (delay ${Math.round(delayMs / 1000)}s)` : ''),
  );
  await xEngagementQueue.add('monitor', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
    ...(delayMs ? { delay: delayMs } : {}),
  });
}

/**
 * Enqueue X metrics collection: batch-fetch tweet performance data.
 */
export async function enqueueXMetrics(data: XMetricsJobData): Promise<void> {
  log.debug(`Enqueued x-metrics for user ${data.userId}`);
  await xMetricsQueue.add('collect', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}
