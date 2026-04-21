// Reply-sweep cron processor — fan-out worker. Every 6h it walks every
// team with a coordinator member and calls `maybeEnqueueReplySweep` for
// its owner. The helper is idempotent and handles:
//
//   - throttling (skip if we already fired within 6h)
//   - empty-inbox skip (skip if no threads discovered in the last 24h)
//   - "already running" skip (a different trigger is active on the team)
//
// So this processor is intentionally thin: find candidate users, call
// the helper, aggregate counts for the log line. Failures on one user
// don't abort the fan-out — we log and continue.

import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { teams } from '@/lib/db/schema';
import { createLogger, loggerForJob } from '@/lib/logger';
import { isStopRequested } from '@/lib/automation-stop';
import { maybeEnqueueReplySweep } from '@/lib/reply-sweep';
import type { ReplySweepCronJobData } from '@/lib/queue/reply-sweep-cron';

const baseLog = createLogger('worker:reply-sweep-cron');

export async function processReplySweepCron(
  job: Job<ReplySweepCronJobData>,
): Promise<void> {
  const log = loggerForJob(baseLog, job);

  // Targeted run (future-proofing): if payload carries a userId, only
  // evaluate that user. Useful for manual kick-offs from admin routes.
  if (job.data.userId) {
    await runForUser(log, job.data.userId);
    return;
  }

  // Fan-out: walk every team and invoke the helper per-user. We go
  // through `teams` (not `channels`) because the helper is team-scoped;
  // a user without a team can't receive a sweep even if their channels
  // are connected.
  const teamRows = await db
    .select({ userId: teams.userId })
    .from(teams);

  const seen = new Set<string>();
  let enqueued = 0;
  const skipCounts = new Map<string, number>();

  for (const row of teamRows) {
    if (seen.has(row.userId)) continue;
    seen.add(row.userId);

    if (await isStopRequested(row.userId)) continue;

    await runForUser(log, row.userId).then((result) => {
      if (result.kind === 'enqueued') {
        enqueued += 1;
      } else {
        skipCounts.set(
          result.reason,
          (skipCounts.get(result.reason) ?? 0) + 1,
        );
      }
    });
  }

  const skipsSummary = Array.from(skipCounts.entries())
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
  log.info(
    `reply-sweep-cron fan-out: users=${seen.size}, enqueued=${enqueued}, skips={${skipsSummary || 'none'}}`,
  );
}

async function runForUser(
  log: ReturnType<typeof loggerForJob>,
  userId: string,
): Promise<
  { kind: 'enqueued' } | { kind: 'skipped'; reason: string }
> {
  try {
    const r = await maybeEnqueueReplySweep(userId);
    if (r.status === 'enqueued') {
      return { kind: 'enqueued' };
    }
    return { kind: 'skipped', reason: r.reason };
  } catch (err) {
    log.error(
      `reply-sweep-cron: maybeEnqueueReplySweep threw for user=${userId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { kind: 'skipped', reason: 'error' };
  }
}
