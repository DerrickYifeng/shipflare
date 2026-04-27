// Daily 13:00 UTC fanout. For each user with at least one connected
// channel AND a product, enqueue one coordinator-rooted team-run with
// `trigger='discovery_cron'`. The coordinator's playbook handles calling
// `Task('discovery-agent')` + dispatching community-manager via Task
// for the queued threads — the scan no longer runs as a standalone
// BullMQ job, and there is no separate reply-drafter teammate (Phase 6
// of the agent-cleanup migration absorbed it into community-manager).
//
// Replaces the prior `discovery-scan.ts` processor. The
// `discovery-scan` BullMQ queue is preserved (the cron schedule still
// drops a fanout job onto it) so this processor stays bound to that
// queue name; per-user `kind: 'user'` payloads no longer exist on it.

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

const baseLog = createLogger('worker:discovery-cron-fanout');

export async function processDiscoveryCronFanout(
  job: Job<DiscoveryScanJobData>,
): Promise<void> {
  const log = loggerForJob(baseLog, job);
  const traceId = getTraceId(job.data, job.id);

  if (!isFanoutJob(job.data)) {
    log.warn(
      'discovery-cron-fanout received a non-fanout job; refusing to process',
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
        `Daily discovery scan for ${product.name}. ` +
        `Connected platforms: ${platforms}. ` +
        `Trigger: discovery_cron. ` +
        `Follow your discovery_cron playbook: dispatch discovery-agent ` +
        `per platform via Task, then dispatch community-manager on the top-3.`;

      await enqueueTeamRun({
        teamId,
        trigger: 'discovery_cron',
        goal,
        rootMemberId: coordinator.id,
        conversationId,
      });
      enqueued++;
    } catch (err) {
      log.warn(
        `discovery-cron-fanout: failed to enqueue for user=${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  log.info(
    `discovery-cron-fanout (trace=${traceId}): enqueued ${enqueued} team-runs`,
  );
}
