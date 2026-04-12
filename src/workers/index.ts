import { Worker } from 'bullmq';
import { getRedis } from '@/lib/redis';
import { processDiscovery } from './processors/discovery';
import { processContent } from './processors/content';
import { processPosting } from './processors/posting';
import { processHealthScore } from './processors/health-score';
import type { DiscoveryJobData, ContentJobData, PostingJobData, HealthScoreJobData } from '@/lib/queue/types';

const connection = getRedis();

/**
 * Worker entry point. Runs as a separate Bun process on Railway.
 * `bun src/workers/index.ts`
 */

const discoveryWorker = new Worker<DiscoveryJobData>(
  'discovery',
  async (job) => processDiscovery(job),
  { connection, concurrency: 2 },
);

const contentWorker = new Worker<ContentJobData>(
  'content',
  async (job) => processContent(job),
  { connection, concurrency: 3 },
);

const postingWorker = new Worker<PostingJobData>(
  'posting',
  async (job) => processPosting(job),
  { connection, concurrency: 1 }, // Serial: never risk parallel posts
);

const healthScoreWorker = new Worker<HealthScoreJobData>(
  'health-score',
  async (job) => processHealthScore(job),
  { connection, concurrency: 1 },
);

const workers = [discoveryWorker, contentWorker, postingWorker, healthScoreWorker];

// Log events
for (const worker of workers) {
  worker.on('completed', (job) => {
    console.log(`[${worker.name}] Job ${job.id} completed`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[${worker.name}] Job ${job?.id} failed:`, err.message);
  });
}

console.log('ShipFlare workers started: discovery, content, posting, health-score');

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down workers...');
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
