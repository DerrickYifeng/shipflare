import { Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '@/lib/redis';
// CRITICAL: side-effect import. registry-team.ts calls registerDeferredTools
// at module load to register Task / SendMessage / Skill / TaskStop / Sleep
// (deferred to break a module-init cycle). Without this import the worker
// process boots with those tools unregistered, and `resolveAgentTools`
// throws "Agent ... declares unknown tool(s): Task, SendMessage" the first
// time agent-run picks up the lead. Tests catch this per-file by importing
// registry-team themselves; the worker boot needs an explicit pull.
// Phase E Task 11 deleted team-run.ts which had been the implicit transitive
// importer; this line re-establishes the registration trigger.
import '@/tools/registry-team';
import { processReview } from './processors/review';
import { processPosting } from './processors/posting';
import { processGrowthRollup } from './processors/growth-rollup';
import { processGrowthRollupFanout } from './processors/growth-rollup-fanout';
import { processDream } from './processors/dream';
import { processCodeScan } from './processors/code-scan';
import { processXEngagement } from './processors/engagement';
import { processXMetrics } from './processors/metrics';
import { processXAnalytics } from './processors/analytics';
import { processDailyRunFanout } from './processors/daily-run-fanout';
import { processPlanExecute } from './processors/plan-execute';
import { processPlanExecuteSweeper } from './processors/plan-execute-sweeper';
import { processStaleSweeper } from './processors/stale-sweeper';
import { processWeeklyReplan } from './processors/weekly-replan';
import { processReconcileMailbox } from './processors/reconcile-mailbox';
import { processAgentRun, disposeAgentStatusBatcher } from './processors/agent-run';
import { processRedditChannelResearch } from './processors/reddit-channel-research';
import {
  AGENT_RUN_QUEUE_NAMES,
  type AgentRunJobData,
  type AgentRunPriority,
} from '@/lib/queue/agent-run';
import { dreamQueue, discoveryScanQueue, metricsQueue, analyticsQueue, growthRollupQueue } from '@/lib/queue';
import type { PlanExecuteJobData, RedditChannelResearchJobData } from '@/lib/queue';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { ReviewJobData, PostingJobData, GrowthRollupJobData, DreamJobData, CodeScanJobData, DiscoveryScanJobData, EngagementJobData, MetricsJobData, AnalyticsJobData } from '@/lib/queue/types';

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

// Reconcile-mailbox cron (Phase B Task 13) — durable backstop for wake()
// failures. Every minute, finds agent_runs with undelivered messages older
// than 30 seconds and re-enqueues them. Single attempt: if a tick fails the
// next minute's tick will catch the same orphans.
const reconcileMailboxQueue = new Queue<Record<string, never>>(
  'reconcile-mailbox',
  {
    connection: getBullMQConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
      attempts: 1,
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

const growthRollupWorker = new Worker<GrowthRollupJobData>(
  'health-score', // queue-name string unchanged for Redis stability
  async (job) => {
    if (job.data.kind === 'fanout') return processGrowthRollupFanout(job);
    return processGrowthRollup(job);
  },
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

// Reddit subreddit kickoff research (one-shot per product). Each job
// runs the `researching-reddit-channels` fork-skill, enriches the top
// candidates via Reddit's public JSON API, and persists top-3 auto
// rows to `product_reddit_channels`. Idempotent on (productId) unless
// the job carries `force: true`.
const redditChannelResearchWorker = new Worker<RedditChannelResearchJobData>(
  'reddit-channel-research',
  async (job) => processRedditChannelResearch(job),
  { ...BASE_OPTS, concurrency: 2 },
);

// Daily-run fan-out — sole entry point for daily automation runs.
// Walks every user with a team + product and dispatches one daily-playbook
// lead message via `ensureDailyRunEnqueued`, rooted in the per-team
// rolling 'Discovery' conversation. The coordinator's `daily` playbook
// handles the per-slot discovery → content-manager loop and falls back
// to default drafting when no slots exist (shouldn't happen in
// practice — onboarding pre-fills plan_items). The BullMQ queue name
// stays 'discovery-scan' for Redis stability with the live repeat
// schedule.
const dailyRunWorker = new Worker<DiscoveryScanJobData>(
  'discovery-scan',
  async (job) => processDailyRunFanout(job),
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

const reconcileMailboxWorker = new Worker<Record<string, never>>(
  'reconcile-mailbox',
  async () => {
    await processReconcileMailbox();
  },
  { ...BASE_OPTS, concurrency: 1 },
);

// AI Team Platform — single-shot agent-run runner (Phase B async lifecycle).
// Phase E Task 11: replaces the old team-run worker. The lead is now a
// regular agent_runs row driven by this worker; founder UI input enters
// via team_messages + wake() instead of a BullMQ team-run job.
// Each job processes one agent turn (drain mailbox → fork skill → persist
// outputs). Lock duration is 10 min — well above the per-turn ceiling but
// short enough that a crashed worker frees the job for another consumer.
//
// B6: split into three lanes (priority/standard/backfill) so a teammate
// burst can't sit ahead of a founder reply. All three share the same
// `processAgentRun` body; only the BullMQ queue name + concurrency
// differs. Total concurrency = 4 + 6 + 2 = 12 — sized for a first-visit
// kickoff burst (1 lead + ~5 specialists = 6 peak) plus headroom for
// concurrent founder priority traffic and cron backfill. Stays under
// the Postgres pool ceiling (`PG_POOL_MAX` env, default 30 in prod —
// see src/lib/db/index.ts).
//
// The per-tenant semaphore from B3 still caps in-flight across all
// three lanes; lanes only decide *order*, not concurrency budget.
const AGENT_RUN_LANE_CONCURRENCY: Record<AgentRunPriority, number> = {
  priority: 4, // founder → lead messages, founder cancels
  standard: 6, // teammate spawns, peer DMs, Sleep resume, TaskStop
  backfill: 2, // reconcile-mailbox, daily-run fan-out, weekly-replan
};

const agentRunWorkers = (
  Object.entries(AGENT_RUN_QUEUE_NAMES) as Array<
    [AgentRunPriority, string]
  >
).map(([lane, name]) => {
  const worker = new Worker<AgentRunJobData>(
    name,
    async (job) => {
      const jobLog = loggerForJob(log, job);
      jobLog.info(
        `agent-run start lane=${lane} agentId=${job.data.agentId}`,
      );
      await processAgentRun(job);
      jobLog.info(
        `agent-run done lane=${lane} agentId=${job.data.agentId}`,
      );
    },
    {
      ...BASE_OPTS,
      concurrency: AGENT_RUN_LANE_CONCURRENCY[lane],
      lockDuration: 600_000,
    },
  );
  worker.on('failed', (job, err) => {
    if (job) {
      loggerForJob(log, job).error(
        `agent-run failed lane=${lane} agentId=${job.data.agentId}: ${err.message}`,
      );
    } else {
      log.error(`agent-run failed lane=${lane} (no job ref): ${err.message}`);
    }
  });
  return worker;
});

const workers = [
  reviewWorker, postingWorker,
  growthRollupWorker, dreamWorker, codeScanWorker,
  dailyRunWorker,
  engagementWorker,
  metricsWorker, analyticsWorker,
  redditChannelResearchWorker,
  // Phase 7
  planExecuteWorker, planExecuteSweeperWorker,
  staleSweeperWorker, weeklyReplanWorker,
  // AI Team Platform — three lanes (priority / standard / backfill)
  ...agentRunWorkers,
  reconcileMailboxWorker,
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

// Schedule growth-rollup: daily at 02:00 UTC.
// Cron timing chosen to avoid overlap with daily-run (13:00 UTC) and
// metrics (03:00 UTC). The fanout processor enqueues one kind:'user'
// job per founder; the user-side processGrowthRollup does the math.
async function scheduleGrowthRollup() {
  await growthRollupQueue.add(
    'fanout',
    { kind: 'fanout', schemaVersion: 1, traceId: 'cron-growth-rollup' },
    {
      repeat: { pattern: '0 2 * * *', tz: 'UTC' },
      jobId: 'growth-rollup-fanout-cron',
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

// Schedule daily-run cron: daily at 13:00 UTC. Single canonical
// fan-out — the processor iterates all users with a channel + product
// and enqueues one coordinator-rooted team-run per user
// (trigger='daily'), rooted in a per-team rolling 'Discovery'
// conversation. /api/automation/run uses the same trigger so manual
// kickoffs and cron runs share one playbook. Queue name stays
// 'discovery-scan' for Redis stability with existing repeat job.
async function scheduleDailyRun() {
  await discoveryScanQueue.add(
    'fanout',
    { kind: 'fanout', schemaVersion: 1, traceId: 'cron-daily-run-fanout' },
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
// whose dueDate is before today as stale.
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

// Schedule reconcile-mailbox: every minute. Finds agent_runs with
// undelivered team_messages older than 30s and re-enqueues their
// agent-run job via wake(). Durable backstop for transient wake()
// failures from SendMessage / Sleep / Task async paths.
async function scheduleReconcileMailbox() {
  await reconcileMailboxQueue.add(
    'tick',
    {},
    {
      repeat: { pattern: '* * * * *' }, // every minute
      jobId: 'reconcile-mailbox-tick',
    },
  );
}

Promise.all([
  scheduleNightlyDream(),
  scheduleDailyRun(),
  scheduleMetrics(),
  scheduleAnalytics(),
  scheduleGrowthRollup(),
  schedulePlanExecuteSweeper(),
  scheduleStaleSweeper(),
  scheduleWeeklyReplan(),
  scheduleReconcileMailbox(),
]).catch((err) => {
  log.error('Failed to schedule cron jobs:', err.message);
});

log.info('All workers started: review, posting, growth-rollup, dream, code-scan, daily-run, engagement, metrics, analytics, reddit-channel-research, plan-execute, plan-execute-sweeper, stale-sweeper, weekly-replan, agent-run (priority/standard/backfill), reconcile-mailbox. daily-run daily 13:00 UTC, growth-rollup daily 02:00 UTC, plan-execute-sweeper every 1m, stale-sweeper every 1h, weekly-replan Monday 00:00 UTC, reconcile-mailbox every 1m, all others daily.');

// Graceful shutdown
async function shutdown() {
  log.info('Shutting down workers...');
  // B7: flush any pending status-batcher entries before BullMQ workers
  // close — otherwise transient queued/running/sleeping/resuming writes
  // buffered for the next 500ms tick get lost on SIGTERM. The dispose
  // fires the final flush fire-and-forget; we give it a brief grace
  // window before exiting so the UPDATE round-trips complete.
  disposeAgentStatusBatcher();
  await new Promise((r) => setTimeout(r, 200));
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
