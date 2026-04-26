import { Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '@/lib/redis';
import { processReview } from './processors/review';
import { processPosting } from './processors/posting';
import { processHealthScore } from './processors/health-score';
import { processDream } from './processors/dream';
import { processCodeScan } from './processors/code-scan';
import { processXMonitor } from './processors/monitor';
import { processXEngagement } from './processors/engagement';
import { processXMetrics } from './processors/metrics';
import { processXAnalytics } from './processors/analytics';
import { processDiscoveryCronFanout } from './processors/discovery-cron-fanout';
import { processPlanExecute } from './processors/plan-execute';
import { processPlanExecuteSweeper } from './processors/plan-execute-sweeper';
import { processStaleSweeper } from './processors/stale-sweeper';
import { processWeeklyReplan } from './processors/weekly-replan';
import { processTeamRun, getTeamRunConcurrency } from './processors/team-run';
import { processReplySweepCron } from './processors/reply-sweep-cron';
import { TEAM_RUN_QUEUE_NAME, type TeamRunJobData } from '@/lib/queue/team-run';
import {
  REPLY_SWEEP_CRON_QUEUE_NAME,
  scheduleReplySweepCron,
  type ReplySweepCronJobData,
} from '@/lib/queue/reply-sweep-cron';
import { dreamQueue, discoveryScanQueue, monitorQueue, metricsQueue, analyticsQueue, codeScanQueue } from '@/lib/queue';
import type { PlanExecuteJobData } from '@/lib/queue';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { ReviewJobData, PostingJobData, HealthScoreJobData, DreamJobData, CodeScanJobData, MonitorJobData, DiscoveryScanJobData, EngagementJobData, MetricsJobData, AnalyticsJobData } from '@/lib/queue/types';

// ----------------------------------------------------------------
//  Phase 7 cron-only queues (no enqueue helpers — scheduled below)
// ----------------------------------------------------------------

const planExecuteSweeperQueue = new Queue<Record<string, never>>(
  'plan-execute-sweeper',
  {
    connection: getBullMQConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
      attempts: 1,
    },
  },
);

const staleSweeperQueue = new Queue<Record<string, never>>(
  'stale-sweeper',
  {
    connection: getBullMQConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
      attempts: 1,
    },
  },
);

const weeklyReplanQueue = new Queue<Record<string, never>>(
  'weekly-replan',
  {
    connection: getBullMQConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
      // Idempotent via Redis lock inside the processor; allow 1 retry
      // in case of a transient DB hiccup reading strategic_paths.
      attempts: 2,
      backoff: { type: 'exponential', delay: 30_000 },
    },
  },
);

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

const discoveryScanWorker = new Worker<DiscoveryScanJobData>(
  'discovery-scan',
  async (job) => processDiscoveryCronFanout(job),
  { ...BASE_OPTS, concurrency: 2, lockDuration: 15_000 },
);

// --- Phase 7: plan-execute workers ---

const planExecuteWorker = new Worker<PlanExecuteJobData>(
  'plan-execute',
  async (job) => processPlanExecute(job),
  { ...BASE_OPTS, concurrency: 3 },
);

const planExecuteSweeperWorker = new Worker<Record<string, never>>(
  'plan-execute-sweeper',
  async (job) => processPlanExecuteSweeper(job),
  { ...BASE_OPTS, concurrency: 1 },
);

const staleSweeperWorker = new Worker<Record<string, never>>(
  'stale-sweeper',
  async (job) => processStaleSweeper(job),
  { ...BASE_OPTS, concurrency: 1 },
);

const weeklyReplanWorker = new Worker<Record<string, never>>(
  'weekly-replan',
  async (job) => processWeeklyReplan(job),
  { ...BASE_OPTS, concurrency: 1 },
);

// AI Team Platform — coordinator main-loop runner.
// Lock duration accommodates a multi-turn coordinator run with delegated
// subagents; each subagent is synchronous from the worker's POV and the full
// chain ceiling is ~10 minutes (spec §15.3 alert threshold).
const teamRunWorker = new Worker<TeamRunJobData>(
  TEAM_RUN_QUEUE_NAME,
  async (job) => processTeamRun(job),
  { ...BASE_OPTS, concurrency: getTeamRunConcurrency(), lockDuration: 15 * 60_000 },
);

// Phase E Day 2 — reply-sweep fan-out. The processor walks teams every
// 6h (cadence defined in src/lib/queue/reply-sweep-cron.ts) and calls
// `maybeEnqueueReplySweep(userId)` for each owner. The helper is
// idempotent and throttles against recent reply_sweep runs, so safe to
// re-fire. See scheduleReplySweepCron() below.
const replySweepCronWorker = new Worker<ReplySweepCronJobData>(
  REPLY_SWEEP_CRON_QUEUE_NAME,
  async (job) => processReplySweepCron(job),
  { ...BASE_OPTS, concurrency: 1 },
);

const workers = [
  reviewWorker, postingWorker,
  healthScoreWorker, dreamWorker, codeScanWorker,
  monitorWorker,
  discoveryScanWorker,
  engagementWorker,
  metricsWorker, analyticsWorker,
  // Phase 7
  planExecuteWorker, planExecuteSweeperWorker,
  staleSweeperWorker, weeklyReplanWorker,
  // AI Team Platform
  teamRunWorker,
  replySweepCronWorker,
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

// Schedule discovery cron baseline: daily at 13:00 UTC. Fan-out entry —
// the processor iterates all users with a channel + product and enqueues
// one coordinator-rooted team-run per user (trigger='discovery_cron'),
// rooted in a per-team rolling 'Discovery' conversation. Replaces the
// pre-team-run scout-only worker that used to fan out per-platform scan
// jobs every 4h.
async function scheduleDiscoveryScan() {
  await discoveryScanQueue.add(
    'fanout',
    { kind: 'fanout', schemaVersion: 1, traceId: 'cron-discovery-scan-fanout' },
    {
      repeat: { pattern: '0 13 * * *', tz: 'UTC' },
      jobId: 'discovery-scan-fanout-repeat',
    },
  );
}

// Schedule plan-execute-sweeper: every 60s. Finds plan_items ready
// for their next phase transition and enqueues plan-execute jobs.
// Idempotent — plan-execute uses (planItemId, phase) jobId dedup so
// re-sweeping an in-flight item is a no-op at the Redis layer.
async function schedulePlanExecuteSweeper() {
  await planExecuteSweeperQueue.add(
    'sweep',
    {},
    {
      repeat: { every: 60 * 1000 },
      jobId: 'plan-execute-sweeper-repeat',
    },
  );
}

// Schedule stale-sweeper: every hour. Marks planned / approved rows
// past scheduledAt + 24h as stale.
async function scheduleStaleSweeper() {
  await staleSweeperQueue.add(
    'sweep',
    {},
    {
      repeat: { every: 60 * 60 * 1000 },
      jobId: 'stale-sweeper-repeat',
    },
  );
}

// Schedule weekly-replan: Monday 00:00 UTC. For every user with an
// active strategic_path, enqueue a tactical-planner run for the
// coming week. The processor acquires a per-(user, week) Redis lock
// so double-fires from cron overlap collapse to one run.
async function scheduleWeeklyReplan() {
  await weeklyReplanQueue.add(
    'replan',
    {},
    {
      repeat: { pattern: '0 0 * * 1' }, // Monday 00:00 UTC
      jobId: 'weekly-replan-cron',
    },
  );
}

Promise.all([
  scheduleNightlyDream(),
  scheduleCodeDiff(),
  scheduleDiscoveryScan(),
  scheduleMonitor(),
  scheduleMetrics(),
  scheduleAnalytics(),
  schedulePlanExecuteSweeper(),
  scheduleStaleSweeper(),
  scheduleWeeklyReplan(),
  scheduleReplySweepCron(),
]).catch((err) => {
  log.error('Failed to schedule cron jobs:', err.message);
});

log.info('All workers started: review, posting, health-score, dream, code-scan, monitor, discovery-scan, engagement, metrics, analytics, plan-execute, plan-execute-sweeper, stale-sweeper, weekly-replan, team-run. discovery-scan daily 13:00 UTC, plan-execute-sweeper every 1m, stale-sweeper every 1h, weekly-replan Monday 00:00 UTC, all others daily.');

// Graceful shutdown
async function shutdown() {
  log.info('Shutting down workers...');
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
