// src/workers/processors/growth-rollup-fanout.ts
import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { enqueueGrowthRollup } from '@/lib/queue';
import type { GrowthRollupJobData } from '@/lib/queue/types';
import { createLogger, loggerForJob } from '@/lib/logger';

const baseLog = createLogger('worker:growth-rollup-fanout');

/**
 * Daily cron entry: enqueues a per-user `kind: 'user'` rollup job for every
 * user with >=1 connected channel. The user-side processor (`processGrowthRollup`)
 * handles the actual rollup math.
 *
 * Mirrors the metrics-queue fanout pattern.
 */
export async function processGrowthRollupFanout(
  job: Job<GrowthRollupJobData>,
): Promise<void> {
  const log = loggerForJob(baseLog, job);
  if (job.data.kind !== 'fanout') {
    log.warn('non-fanout payload sent to growth-rollup-fanout; ignoring');
    return;
  }

  // Explicit projection - never select token columns from `channels`
  // (CLAUDE.md security rule).
  const rows = await db
    .select({ userId: channels.userId })
    .from(channels);

  const userIds = Array.from(new Set(rows.map((r) => r.userId)));
  log.info(`Fanning out growth-rollup to ${userIds.length} users`);

  for (const userId of userIds) {
    await enqueueGrowthRollup({ kind: 'user', userId });
  }
}
