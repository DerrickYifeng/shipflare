// Daily 13:00 UTC fanout. For each user with at least one connected
// channel AND a product, ensure the team exists and dispatch a single
// "daily playbook" lead message via the shared `ensureDailyRunEnqueued`
// helper. The coordinator's daily playbook handles per-slot
// discovery → content-manager loop (driven by today's `content_reply`
// plan_items emitted by content-planner) and falls back to default
// drafting when no slots exist.
//
// This is the SOLE entry point for daily automation runs — there is no
// manual trigger anymore. Every system-driven run goes through the same
// path the kickoff helper uses (insert team_message → wake lead), so the
// runtime model stays uniform with CLAUDE.md's "Founder UI mental model"
// (the lead is always sleeping; messages are the only wake source).
//
// The BullMQ queue name stays `discovery-scan` for Redis stability with
// the existing repeat schedule; only the processor name changed.

import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { channels, products } from '@/lib/db/schema';
import { ensureTeamExists } from '@/lib/team-provisioner';
import { ensureDailyRunEnqueued } from '@/lib/team-daily-run';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { DiscoveryScanJobData } from '@/lib/queue/types';
import { isFanoutJob, getTraceId } from '@/lib/queue/types';

const baseLog = createLogger('worker:daily-run-fanout');

export async function processDailyRunFanout(
  job: Job<DiscoveryScanJobData>,
): Promise<void> {
  const log = loggerForJob(baseLog, job);
  const traceId = getTraceId(job.data, job.id);

  if (!isFanoutJob(job.data)) {
    log.warn(
      'daily-run-fanout received a non-fanout job; refusing to process',
    );
    return;
  }

  // Distinct (userId) with at least one channel + a product.
  // Explicit projection — never select token columns from `channels`.
  const channelRows = await db
    .select({ userId: channels.userId, platform: channels.platform })
    .from(channels);

  const userPlatforms = new Map<string, Set<string>>();
  for (const c of channelRows) {
    if (!userPlatforms.has(c.userId)) userPlatforms.set(c.userId, new Set());
    userPlatforms.get(c.userId)!.add(c.platform);
  }

  let enqueued = 0;
  for (const [userId, platformSet] of userPlatforms) {
    const [product] = await db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(eq(products.userId, userId))
      .limit(1);
    if (!product) continue;

    try {
      const { teamId } = await ensureTeamExists(userId, product.id);
      const result = await ensureDailyRunEnqueued({
        userId,
        productId: product.id,
        teamId,
        platforms: Array.from(platformSet),
        source: 'cron',
      });
      if (result.fired) enqueued++;
    } catch (err) {
      log.warn(
        `daily-run-fanout: failed to enqueue for user=${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  log.info(
    `daily-run-fanout (trace=${traceId}): dispatched ${enqueued} lead messages`,
  );
}
