import { Queue } from 'bullmq';
import { getRedis } from '@/lib/redis';
import type {
  DiscoveryJobData,
  ContentJobData,
  PostingJobData,
  HealthScoreJobData,
} from './types';

const connection = { connection: getRedis() };

export const discoveryQueue = new Queue<DiscoveryJobData>(
  'discovery',
  connection,
);
export const contentQueue = new Queue<ContentJobData>('content', connection);
export const postingQueue = new Queue<PostingJobData>('posting', connection);
export const healthScoreQueue = new Queue<HealthScoreJobData>(
  'health-score',
  connection,
);

/**
 * Enqueue a discovery scan for a user's product across subreddits.
 */
export async function enqueueDiscovery(data: DiscoveryJobData): Promise<void> {
  await discoveryQueue.add('scan', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

/**
 * Enqueue content generation for a discovered thread.
 */
export async function enqueueContent(data: ContentJobData): Promise<void> {
  await contentQueue.add('draft', data, {
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
  await healthScoreQueue.add('calculate', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}
