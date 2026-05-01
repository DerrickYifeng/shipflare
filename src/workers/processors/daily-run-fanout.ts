// Daily 13:00 UTC fanout. For each user with at least one connected
// channel AND a product, enqueue one coordinator-rooted team-run with
// `trigger='daily'`. The coordinator's `daily` playbook handles the
// per-slot discovery → community-manager loop (driven by today's
// `content_reply` plan_items emitted by content-planner) and falls back
// to default top-3 drafting when no slots exist.
//
// /api/automation/run uses the same trigger so manual kickoffs and cron
// runs share one playbook — there is no separate `manual` /
// `discovery_cron` / `reply_sweep` trigger anymore.
//
// The BullMQ queue name stays `discovery-scan` for Redis stability with
// the existing repeat schedule; only the processor name changed.

import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { channels, products, teamMembers } from '@/lib/db/schema';
import { isStopRequested } from '@/lib/automation-stop';
import { ensureTeamExists } from '@/lib/team-provisioner';
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { resolveRollingConversation } from '@/lib/team-rolling-conversation';
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
    if (await isStopRequested(userId)) continue;

    const [product] = await db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(eq(products.userId, userId))
      .limit(1);
    if (!product) continue;

    try {
      const { teamId } = await ensureTeamExists(userId, product.id);
      const memberRows = await db
        .select({ id: teamMembers.id, agentType: teamMembers.agentType })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, teamId));
      const coordinator = memberRows.find(
        (m) => m.agentType === 'coordinator',
      );
      if (!coordinator) {
        log.warn(
          `user=${userId} team=${teamId} missing coordinator — skipping`,
        );
        continue;
      }

      const conversationId = await resolveRollingConversation(
        teamId,
        'Discovery',
      );
      const platforms = Array.from(platformSet).join(', ');
      const goal =
        `Daily automation run for ${product.name}. ` +
        `Connected platforms: ${platforms}. ` +
        `Trigger: daily. Source: cron. ` +
        `Follow your daily playbook: load today's content_reply plan_items ` +
        `for this user, run the per-slot discovery → community-manager loop ` +
        `(max 3 inner attempts per slot), and update_plan_item state='drafted' ` +
        `when each slot terminates. If no slots are found, fall back to ` +
        `default top-3 drafting from a single discovery-agent dispatch.`;

      await enqueueTeamRun({
        teamId,
        trigger: 'daily',
        goal,
        rootMemberId: coordinator.id,
        conversationId,
      });
      enqueued++;
    } catch (err) {
      log.warn(
        `daily-run-fanout: failed to enqueue for user=${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  log.info(
    `daily-run-fanout (trace=${traceId}): enqueued ${enqueued} team-runs`,
  );
}
