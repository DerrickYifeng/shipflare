import { z } from 'zod';

/**
 * Every Job payload carries an explicit `schemaVersion` so we can rev the
 * contract without breaking in-flight jobs. `enqueueXxx` sets it to 1 on the
 * way in; processors should treat absent versions as 1 for back-compat.
 *
 * For cron fan-out jobs we use a discriminated union on `kind`:
 *  - `kind: 'fanout'` — scheduled cron entry; the processor iterates users
 *    and enqueues per-user jobs.
 *  - `kind: 'user'` (default, also implied when `kind` is omitted on legacy
 *    payloads) — per-user work.
 *
 * Every payload also carries an optional `traceId` so one can follow a single
 * logical run across enqueue → processor → downstream API calls. `enqueueXxx`
 * mints a fresh UUID when the caller did not supply one. Legacy payloads
 * without a traceId are tolerated (processor falls back to `job.id`).
 */

const SCHEMA_VERSION = z.literal(1).default(1);
const TRACE_ID = z.string().min(1).optional();

// ---------------------------------------------------------------------------
// Review / Posting
// ---------------------------------------------------------------------------

export const reviewJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  draftId: z.string().min(1),
  productId: z.string().min(1),
});
export type ReviewJobData = z.input<typeof reviewJobSchema>;

export const postingJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  draftId: z.string().min(1),
  channelId: z.string().min(1),
  /**
   * 'direct' = posting processor calls platform clients straight (manual
   *            user approve, plan-execute auto-approve, reply-sweep when
   *            we trust the draft as-is).
   * 'agent'  = posting processor runs the posting agent (legacy autonomous
   *            path; agent decides what to call + verifies).
   * Default 'agent' for back-compat with any in-flight jobs whose payload
   * was enqueued before this field existed.
   */
  mode: z.enum(['direct', 'agent']).default('agent'),
});
export type PostingJobData = z.input<typeof postingJobSchema>;

// ---------------------------------------------------------------------------
// Health score
// ---------------------------------------------------------------------------

export const healthScoreJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
});
export type HealthScoreJobData = z.input<typeof healthScoreJobSchema>;

// ---------------------------------------------------------------------------
// Dream / Code scan
// ---------------------------------------------------------------------------

export const dreamJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  productId: z.string().min(1),
});
export type DreamJobData = z.input<typeof dreamJobSchema>;

export const codeScanJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  repoFullName: z.string().min(1),
  repoUrl: z.string().min(1),
  githubToken: z.string().min(1),
  /** When true, perform incremental diff instead of full scan. */
  isDailyDiff: z.boolean().optional(),
});
export type CodeScanJobData = z.input<typeof codeScanJobSchema>;

// ---------------------------------------------------------------------------
// Engagement
// ---------------------------------------------------------------------------

/**
 * Engagement payload only carries the content's external ID. The processor
 * looks up the original draft/post text from the database. Legacy payloads
 * that included `contentText` are still accepted for back-compat; the field
 * is ignored at the consumer side.
 */
export const engagementJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  contentId: z.string().min(1),
  productId: z.string(),
  platform: z.string().min(1),
  /**
   * Optional draft id for fast lookup. If absent, processor resolves via
   * `posts.externalId = contentId`.
   */
  draftId: z.string().optional(),
  /** @deprecated Legacy field — ignored by consumers. Do not pass to new enqueues. */
  contentText: z.string().optional(),
});
export type EngagementJobData = z.input<typeof engagementJobSchema>;

// ---------------------------------------------------------------------------
// Metrics / Analytics
// ---------------------------------------------------------------------------

const metricsUserJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  platform: z.string().min(1),
});

const metricsFanoutJobSchema = z.object({
  kind: z.literal('fanout'),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  platform: z.string().min(1),
});

export const metricsJobSchema = z.union([
  metricsFanoutJobSchema,
  metricsUserJobSchema,
]);
export type MetricsJobData = z.input<typeof metricsJobSchema>;

const analyticsUserJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  platform: z.string().min(1),
});

const analyticsFanoutJobSchema = z.object({
  kind: z.literal('fanout'),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  platform: z.string().min(1),
});

export const analyticsJobSchema = z.union([
  analyticsFanoutJobSchema,
  analyticsUserJobSchema,
]);
export type AnalyticsJobData = z.input<typeof analyticsJobSchema>;

// ---------------------------------------------------------------------------
// Discovery scan (top-level orchestrator)
// ---------------------------------------------------------------------------

/**
 * Top-level scan orchestrator job. Runs the discovery-scout agent
 * The discovery-scan queue is now fanout-only: a daily cron drops one
 * fanout job and the processor (`discovery-cron-fanout.ts`) iterates
 * every user with at least one channel + product and enqueues a
 * coordinator-rooted team-run for each. The pre-team-run per-user
 * `kind: 'user'` shape (and its `enqueueDiscoveryScan` helper) is
 * retired — manual "scan now" buttons enqueue team-runs directly via
 * the `/api/discovery/{trigger,scan}` and `/api/automation/run` routes.
 */
export const discoveryScanJobSchema = z.object({
  kind: z.literal('fanout'),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
});
export type DiscoveryScanJobData = z.input<typeof discoveryScanJobSchema>;

// ---------------------------------------------------------------------------
// Back-compat aliases (will be removed after full migration)
// ---------------------------------------------------------------------------

export type XEngagementJobData = EngagementJobData;
export type XMetricsJobData = MetricsJobData;
export type XAnalyticsJobData = AnalyticsJobData;

export type JobData =
  | ReviewJobData
  | PostingJobData
  | HealthScoreJobData
  | DreamJobData
  | CodeScanJobData
  | DiscoveryScanJobData
  | EngagementJobData
  | MetricsJobData
  | AnalyticsJobData;

// ---------------------------------------------------------------------------
// Runtime helpers for processors
// ---------------------------------------------------------------------------

/**
 * Returns true when the payload represents a cron fan-out entry rather than
 * per-user work. Tolerates legacy payloads without `kind` (treated as 'user')
 * and the historical `userId === '__all__'` sentinel.
 */
export function isFanoutJob(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (d.kind === 'fanout') return true;
  // Legacy sentinel — remove once all in-flight jobs drain.
  if (d.userId === '__all__') return true;
  return false;
}

/**
 * Extract the traceId carried by a job payload. Falls back to the jobId when
 * the payload predates traceId threading, so there's always *some* correlator
 * to bind onto logs.
 */
export function getTraceId(data: unknown, jobId?: string): string {
  if (data && typeof data === 'object') {
    const t = (data as Record<string, unknown>).traceId;
    if (typeof t === 'string' && t.length > 0) return t;
  }
  return jobId ?? 'unknown';
}
