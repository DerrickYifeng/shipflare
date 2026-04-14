import { Worker } from 'bullmq';
import { getRedis } from '@/lib/redis';
import { processDiscovery } from './processors/discovery';
import { processContent } from './processors/content';
import { processReview } from './processors/review';
import { processPosting } from './processors/posting';
import { processHealthScore } from './processors/health-score';
import { processDream } from './processors/dream';
import { processCodeScan } from './processors/code-scan';
import { processXMonitor } from './processors/monitor';
import { processXContentCalendar } from './processors/content-calendar';
import { processXEngagement } from './processors/engagement';
import { processXMetrics } from './processors/metrics';
import { dreamQueue, xMonitorQueue, xContentCalendarQueue, xMetricsQueue } from '@/lib/queue';
import { createLogger } from '@/lib/logger';
import type { DiscoveryJobData, ContentJobData, ReviewJobData, PostingJobData, HealthScoreJobData, DreamJobData, CodeScanJobData, XMonitorJobData, XContentCalendarJobData, XEngagementJobData, XMetricsJobData } from '@/lib/queue/types';

const log = createLogger('workers');

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

const reviewWorker = new Worker<ReviewJobData>(
  'review',
  async (job) => processReview(job),
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

const dreamWorker = new Worker<DreamJobData>(
  'dream',
  async (job) => processDream(job),
  { connection, concurrency: 1 },
);

const codeScanWorker = new Worker<CodeScanJobData>(
  'code-scan',
  async (job) => processCodeScan(job),
  { connection, concurrency: 2 },
);

// X Growth workers
const xMonitorWorker = new Worker<XMonitorJobData>(
  'x-monitor',
  async (job) => processXMonitor(job),
  { connection, concurrency: 2 },
);

const xContentCalendarWorker = new Worker<XContentCalendarJobData>(
  'x-content-calendar',
  async (job) => processXContentCalendar(job),
  { connection, concurrency: 2 },
);

const xEngagementWorker = new Worker<XEngagementJobData>(
  'x-engagement',
  async (job) => processXEngagement(job),
  { connection, concurrency: 3 },
);

const xMetricsWorker = new Worker<XMetricsJobData>(
  'x-metrics',
  async (job) => processXMetrics(job),
  { connection, concurrency: 1 },
);

const workers = [
  discoveryWorker, contentWorker, reviewWorker, postingWorker,
  healthScoreWorker, dreamWorker, codeScanWorker,
  xMonitorWorker, xContentCalendarWorker, xEngagementWorker, xMetricsWorker,
];

// Log events
for (const worker of workers) {
  worker.on('active', (job) => {
    log.debug(`[${worker.name}] job ${job.id} active`);
  });
  worker.on('completed', (job) => {
    log.info(`[${worker.name}] job ${job.id} completed`);
  });
  worker.on('failed', (job, err) => {
    log.error(`[${worker.name}] job ${job?.id} failed: ${err.message}`);
  });
}

// Schedule nightly distillation as safety net (4am daily).
// Threshold-triggered distillation from discovery/content processors
// handles the responsive case; this catches anything that slips through.
async function scheduleNightlyDream() {
  await dreamQueue.add(
    'distill-all',
    { productId: '__all__' },
    {
      repeat: { pattern: '0 4 * * *' },
      jobId: 'nightly-distill',
    },
  );
}

// Schedule X monitor: every 15 minutes
async function scheduleXMonitor() {
  await xMonitorQueue.add(
    'scheduled-scan',
    { userId: '__all__', productId: '__all__' },
    {
      repeat: { pattern: '*/15 * * * *' },
      jobId: 'x-monitor-cron',
    },
  );
}

// Schedule X content calendar: every hour
async function scheduleXContentCalendar() {
  await xContentCalendarQueue.add(
    'scheduled-process',
    { userId: '__all__', productId: '__all__' },
    {
      repeat: { pattern: '0 * * * *' },
      jobId: 'x-content-calendar-cron',
    },
  );
}

// Schedule X metrics: every 6 hours
async function scheduleXMetrics() {
  await xMetricsQueue.add(
    'scheduled-collect',
    { userId: '__all__' },
    {
      repeat: { pattern: '0 */6 * * *' },
      jobId: 'x-metrics-cron',
    },
  );
}

Promise.all([
  scheduleNightlyDream(),
  scheduleXMonitor(),
  scheduleXContentCalendar(),
  scheduleXMetrics(),
]).catch((err) => {
  log.error('Failed to schedule cron jobs:', err.message);
});

log.info('All workers started: discovery, content, review, posting, health-score, dream, code-scan, x-monitor, x-content-calendar, x-engagement, x-metrics');

// Graceful shutdown
async function shutdown() {
  log.info('Shutting down workers...');
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
