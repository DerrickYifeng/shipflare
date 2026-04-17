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
// Discovery
// ---------------------------------------------------------------------------

const discoveryUserJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  productId: z.string().min(1),
  sources: z.array(z.string()),
  platform: z.string().min(1),
});

const discoveryFanoutJobSchema = z.object({
  kind: z.literal('fanout'),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
});

export const discoveryJobSchema = z.union([
  discoveryFanoutJobSchema,
  discoveryUserJobSchema,
]);
export type DiscoveryJobData = z.input<typeof discoveryJobSchema>;

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export const contentJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  threadId: z.string().min(1),
  productId: z.string().min(1),
  draftType: z.enum(['reply', 'original_post']).optional(),
  communityIntel: z.unknown().optional(),
});
export type ContentJobData = z.input<typeof contentJobSchema>;

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
// Monitor
// ---------------------------------------------------------------------------

const monitorUserJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  productId: z.string().min(1),
  platform: z.string().min(1),
});

const monitorFanoutJobSchema = z.object({
  kind: z.literal('fanout'),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  platform: z.string().min(1),
});

export const monitorJobSchema = z.union([
  monitorFanoutJobSchema,
  monitorUserJobSchema,
]);
export type MonitorJobData = z.input<typeof monitorJobSchema>;

// ---------------------------------------------------------------------------
// Content calendar
// ---------------------------------------------------------------------------

const contentCalendarUserJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  productId: z.string().min(1),
  platform: z.string().min(1),
  /** When true, process items scheduled within next 48h, not just overdue. */
  processUpcoming: z.boolean().optional(),
});

const contentCalendarFanoutJobSchema = z.object({
  kind: z.literal('fanout'),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  platform: z.string().min(1),
});

export const contentCalendarJobSchema = z.union([
  contentCalendarFanoutJobSchema,
  contentCalendarUserJobSchema,
]);
export type ContentCalendarJobData = z.input<typeof contentCalendarJobSchema>;

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
// Today / Calibration
// ---------------------------------------------------------------------------

const todoSeedUserJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
});

const todoSeedFanoutJobSchema = z.object({
  kind: z.literal('fanout'),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
});

export const todoSeedJobSchema = z.union([
  todoSeedFanoutJobSchema,
  todoSeedUserJobSchema,
]);
export type TodoSeedJobData = z.input<typeof todoSeedJobSchema>;

export const calibrationJobSchema = z.object({
  kind: z.literal('user').optional(),
  schemaVersion: SCHEMA_VERSION,
  traceId: TRACE_ID,
  userId: z.string().min(1),
  productId: z.string().min(1),
  /** Max calibration rounds (default: 10). Use 3 for mini re-calibration. */
  maxRounds: z.number().int().positive().optional(),
});
export type CalibrationJobData = z.input<typeof calibrationJobSchema>;

// ---------------------------------------------------------------------------
// Back-compat aliases (will be removed after full migration)
// ---------------------------------------------------------------------------

export type XMonitorJobData = MonitorJobData;
export type XContentCalendarJobData = ContentCalendarJobData;
export type XEngagementJobData = EngagementJobData;
export type XMetricsJobData = MetricsJobData;
export type XAnalyticsJobData = AnalyticsJobData;

export type JobData =
  | DiscoveryJobData
  | ContentJobData
  | ReviewJobData
  | PostingJobData
  | HealthScoreJobData
  | DreamJobData
  | CodeScanJobData
  | MonitorJobData
  | ContentCalendarJobData
  | EngagementJobData
  | MetricsJobData
  | AnalyticsJobData
  | TodoSeedJobData
  | CalibrationJobData;

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
