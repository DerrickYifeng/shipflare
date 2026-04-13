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
