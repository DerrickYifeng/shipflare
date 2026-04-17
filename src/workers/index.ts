import { Worker } from 'bullmq';
import { getBullMQConnection } from '@/lib/redis';
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
import { processXAnalytics } from './processors/analytics';
import { processTodoSeed } from './processors/todo-seed';
import { processCalibration } from './processors/calibrate-discovery';
import { dreamQueue, discoveryQueue, monitorQueue, contentCalendarQueue, metricsQueue, analyticsQueue, todoSeedQueue, codeScanQueue } from '@/lib/queue';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { DiscoveryJobData, ContentJobData, ReviewJobData, PostingJobData, HealthScoreJobData, DreamJobData, CodeScanJobData, MonitorJobData, ContentCalendarJobData, EngagementJobData, MetricsJobData, AnalyticsJobData, TodoSeedJobData, CalibrationJobData } from '@/lib/queue/types';

const log = createLogger('workers');

const connection = getBullMQConnection();

/**
 * Worker entry point. Runs as a separate Bun process on Railway.
 * `bun src/workers/index.ts`
 *
 * lockDuration: 5 min upper bound — if the process crashes, the lock expires
 * and another worker picks up the job.
 * lockRenewTime: 30s — BullMQ auto-renews the lock every 30s while the
 * processor is alive. Jobs never get marked "stalled" during normal execution.
 */
const BASE_OPTS = {
  connection,
  lockDuration: 300_000,
  lockRenewTime: 30_000,
};

const discoveryWorker = new Worker<DiscoveryJobData>(
  'discovery',
  async (job) => processDiscovery(job),
  { ...BASE_OPTS, concurrency: 2 },
);

const contentWorker = new Worker<ContentJobData>(
  'content',
  async (job) => processContent(job),
  { ...BASE_OPTS, concurrency: 3 },
);

const reviewWorker = new Worker<ReviewJobData>(
  'review',
  async (job) => processReview(job),
  { ...BASE_OPTS, concurrency: 3 },
);

const postingWorker = new Worker<PostingJobData>(
  'posting',
  async (job) => processPosting(job),
  { ...BASE_OPTS, concurrency: 1 }, // Serial: never risk parallel posts
);

const healthScoreWorker = new Worker<HealthScoreJobData>(
  'health-score',
  async (job) => processHealthScore(job),
  { ...BASE_OPTS, concurrency: 1 },
);

const dreamWorker = new Worker<DreamJobData>(
  'dream',
  async (job) => processDream(job),
  { ...BASE_OPTS, concurrency: 1 },
);

const codeScanWorker = new Worker<CodeScanJobData>(
  'code-scan',
  async (job) => processCodeScan(job),
  { ...BASE_OPTS, concurrency: 2 },
);

// Growth workers (currently X-only, platform-aware for future expansion)
const monitorWorker = new Worker<MonitorJobData>(
  'monitor',
  async (job) => processXMonitor(job),
  { ...BASE_OPTS, concurrency: 2 },
);

const contentCalendarWorker = new Worker<ContentCalendarJobData>(
  'content-calendar',
  async (job) => processXContentCalendar(job),
  { ...BASE_OPTS, concurrency: 2 },
);

const engagementWorker = new Worker<EngagementJobData>(
  'engagement',
  async (job) => processXEngagement(job),
  { ...BASE_OPTS, concurrency: 3 },
);

const metricsWorker = new Worker<MetricsJobData>(
  'metrics',
  async (job) => processXMetrics(job),
  { ...BASE_OPTS, concurrency: 1 },
);

const analyticsWorker = new Worker<AnalyticsJobData>(
  'analytics',
  async (job) => processXAnalytics(job),
  { ...BASE_OPTS, concurrency: 1 },
);

const todoSeedWorker = new Worker<TodoSeedJobData>(
  'todo-seed',
  async (job) => processTodoSeed(job),
  { ...BASE_OPTS, concurrency: 1 },
);

const calibrationWorker = new Worker<CalibrationJobData>(
  'calibration',
  async (job) => processCalibration(job),
  {
    ...BASE_OPTS,
    concurrency: 1,
    lockDuration: 30 * 60_000, // 30 min — calibration can run up to 25 min
  },
);

const workers = [
  discoveryWorker, contentWorker, reviewWorker, postingWorker,
  healthScoreWorker, dreamWorker, codeScanWorker,
  monitorWorker, contentCalendarWorker, engagementWorker, metricsWorker,
  analyticsWorker, todoSeedWorker, calibrationWorker,
];

// Log events — bind traceId / jobId / queue into the child logger so lifecycle
// events land in the same structured form as processor-emitted lines.
for (const worker of workers) {
  worker.on('active', (job) => {
    loggerForJob(log, job).debug('job active');
  });
  worker.on('completed', (job) => {
    loggerForJob(log, job).info('job completed');
  });
  worker.on('failed', (job, err) => {
    if (job) {
      loggerForJob(log, job).error(`job failed: ${err.message}`);
    } else {
      log.error(`[${worker.name}] job failed (no job ref): ${err.message}`);
    }
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

// Schedule monitor: daily at 7am UTC
async function scheduleMonitor() {
  await monitorQueue.add(
    'scheduled-scan',
    { kind: 'fanout', schemaVersion: 1, platform: 'x' },
    {
      repeat: { pattern: '0 7 * * *' },
      jobId: 'monitor-cron',
    },
  );
}

// Schedule content calendar: daily at 6am UTC (before monitor, so drafts are ready)
async function scheduleContentCalendar() {
  await contentCalendarQueue.add(
    'scheduled-process',
    { kind: 'fanout', schemaVersion: 1, platform: 'x' },
    {
      repeat: { pattern: '0 6 * * *' },
      jobId: 'content-calendar-cron',
    },
  );
}

// Schedule metrics: daily at 3am UTC
async function scheduleMetrics() {
  await metricsQueue.add(
    'scheduled-collect',
    { kind: 'fanout', schemaVersion: 1, platform: 'x' },
    {
      repeat: { pattern: '0 3 * * *' },
      jobId: 'metrics-cron',
    },
  );
}

// Schedule analytics: daily at 5am UTC (after metrics and dream)
async function scheduleAnalytics() {
  await analyticsQueue.add(
    'scheduled-compute',
    { kind: 'fanout', schemaVersion: 1, platform: 'x' },
    {
      repeat: { pattern: '0 5 * * *' },
      jobId: 'analytics-cron',
    },
  );
}

// Schedule todo seed: hourly check — seeds each user when their local time is 8 AM
async function scheduleTodoSeed() {
  await todoSeedQueue.add(
    'scheduled-seed',
    { kind: 'fanout', schemaVersion: 1 },
    {
      repeat: { pattern: '0 * * * *' },
      jobId: 'todo-seed-cron',
    },
  );
}

// Schedule daily code diff: 2am UTC (before metrics at 3am)
async function scheduleCodeDiff() {
  await codeScanQueue.add(
    'daily-diff',
    { userId: '__all__', repoFullName: '', repoUrl: '', githubToken: '', isDailyDiff: true },
    {
      repeat: { pattern: '0 2 * * *' },
      jobId: 'code-diff-cron',
    },
  );
}

// Schedule discovery: 3x daily (8am, 2pm, 8pm UTC)
async function scheduleDiscovery() {
  await discoveryQueue.add(
    'scheduled-scan',
    { kind: 'fanout', schemaVersion: 1 },
    {
      repeat: { pattern: '0 8,14,20 * * *' },
      jobId: 'discovery-cron',
    },
  );
}

Promise.all([
  scheduleNightlyDream(),
  scheduleCodeDiff(),
  scheduleDiscovery(),
  scheduleMonitor(),
  scheduleContentCalendar(),
  scheduleMetrics(),
  scheduleAnalytics(),
  scheduleTodoSeed(),
]).catch((err) => {
  log.error('Failed to schedule cron jobs:', err.message);
});

log.info('All workers started: discovery, content, review, posting, health-score, dream, code-scan, monitor, content-calendar, engagement, metrics, analytics, todo-seed, calibration. Discovery 3x/day, all others daily.');

// Graceful shutdown
async function shutdown() {
  log.info('Shutting down workers...');
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
