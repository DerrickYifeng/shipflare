import { getKeyValueClient } from '@/lib/redis';
import { createLogger } from '@/lib/logger';
import type { UsageSummary } from '@/core/types';

/**
 * Per-run cost bucket — a Redis-backed aggregator that answers the
 * "how much did this logical run cost?" question.
 *
 * A "run" is identified by the same traceId we thread through BullMQ payloads
 * (see `src/lib/queue/types.ts`), so the full chain
 *     API route → discovery → content → review → posting
 * accumulates into a single bucket at `cost:run:{traceId}`.
 *
 * Storage layout — a Redis hash per run:
 *   cost:run:{traceId} = {
 *     costUsd:         "0.0423"              (stringified float, HINCRBYFLOAT)
 *     inputTokens:     "124500"              (HINCRBY)
 *     outputTokens:    "3210"
 *     cacheReadTokens: "98700"
 *     cacheWriteTokens:"12800"
 *     turns:           "7"
 *     models:          "claude-sonnet-4-6,claude-haiku-4-5"  (CSV of seen models)
 *     firstSeenTs:     "2024-11-01T12:34:56Z"
 *     lastUpdatedTs:   "2024-11-01T12:35:12Z"
 *   }
 *
 * Why Redis and not just logs? So the review/posting stages can *read* the
 * accumulated cost of preceding stages in the same run (useful for budget
 * enforcement) — something pure log scraping can't give us without an
 * aggregation pipeline.
 *
 * Entries expire after 7 days by default so finished runs drain themselves.
 */

const log = createLogger('lib:cost-bucket');

const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function bucketKey(runId: string): string {
  return `cost:run:${runId}`;
}

export interface CostSnapshot {
  runId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  models: string[];
  firstSeenTs: string | null;
  lastUpdatedTs: string | null;
}

/**
 * Add a UsageSummary (from an Anthropic SDK call / skill run) into the bucket
 * for `runId`. Failures are logged and swallowed — cost accounting must not
 * break the hot path when Redis hiccups.
 */
export async function addCost(runId: string, usage: UsageSummary): Promise<void> {
  if (!runId) return;
  const key = bucketKey(runId);
  const redis = getKeyValueClient();
  const nowIso = new Date().toISOString();

  try {
    // Pipeline so we pay one RTT for the full update.
    const pipe = redis.pipeline();
    pipe.hincrbyfloat(key, 'costUsd', usage.costUsd);
    pipe.hincrby(key, 'inputTokens', usage.inputTokens);
    pipe.hincrby(key, 'outputTokens', usage.outputTokens);
    pipe.hincrby(key, 'cacheReadTokens', usage.cacheReadTokens);
    pipe.hincrby(key, 'cacheWriteTokens', usage.cacheWriteTokens);
    pipe.hincrby(key, 'turns', usage.turns);

    // Append the model to the CSV if it isn't already there. We do this via
    // HGET → compute → HSET because Redis has no "append-if-absent" primitive
    // for hash fields; the race is harmless (worst case: a dup entry).
    const existingModels = await redis.hget(key, 'models');
    const set = new Set((existingModels ?? '').split(',').filter(Boolean));
    set.add(usage.model);
    pipe.hset(key, 'models', [...set].join(','));

    // Track first-seen / last-updated timestamps (HSETNX only writes if missing).
    pipe.hsetnx(key, 'firstSeenTs', nowIso);
    pipe.hset(key, 'lastUpdatedTs', nowIso);
    pipe.expire(key, TTL_SECONDS);

    await pipe.exec();
  } catch (err) {
    log.warn(`addCost failed for run ${runId}: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

/**
 * Retrieve the accumulated cost for `runId`. Returns zeroed snapshot when the
 * bucket doesn't exist (run never started, already expired, or no traceId
 * was threaded through).
 */
export async function getCostForRun(runId: string): Promise<CostSnapshot> {
  const empty: CostSnapshot = {
    runId,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: 0,
    models: [],
    firstSeenTs: null,
    lastUpdatedTs: null,
  };
  if (!runId) return empty;

  try {
    const raw = await getKeyValueClient().hgetall(bucketKey(runId));
    if (!raw || Object.keys(raw).length === 0) return empty;
    return {
      runId,
      costUsd: parseFloat(raw.costUsd ?? '0') || 0,
      inputTokens: parseInt(raw.inputTokens ?? '0', 10) || 0,
      outputTokens: parseInt(raw.outputTokens ?? '0', 10) || 0,
      cacheReadTokens: parseInt(raw.cacheReadTokens ?? '0', 10) || 0,
      cacheWriteTokens: parseInt(raw.cacheWriteTokens ?? '0', 10) || 0,
      turns: parseInt(raw.turns ?? '0', 10) || 0,
      models: (raw.models ?? '').split(',').filter(Boolean),
      firstSeenTs: raw.firstSeenTs ?? null,
      lastUpdatedTs: raw.lastUpdatedTs ?? null,
    };
  } catch (err) {
    log.warn(`getCostForRun failed for run ${runId}: ${err instanceof Error ? err.message : 'unknown'}`);
    return empty;
  }
}

/**
 * Delete the bucket (e.g. after terminal logging / billing accrual). Normally
 * you don't need to call this — entries expire after 7 days. Provided so tests
 * and ops scripts can reset state deterministically.
 */
export async function dropCostBucket(runId: string): Promise<void> {
  if (!runId) return;
  try {
    await getKeyValueClient().del(bucketKey(runId));
  } catch (err) {
    log.warn(`dropCostBucket failed for run ${runId}: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}
