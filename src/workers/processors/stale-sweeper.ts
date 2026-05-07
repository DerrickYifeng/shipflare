import type { Job } from 'bullmq';
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { drafts, planItems } from '@/lib/db/schema';
import { recordPipelineEventsBulk } from '@/lib/pipeline-events';
import { createLogger, loggerForJob } from '@/lib/logger';

const log = createLogger('worker:stale-sweeper');

/**
 * How long past `scheduledAt` a planned item can sit before we mark
 * it `stale`. 24 hours matches spec §5.2 + §6. Past the window means
 * the founder ignored the item through a full day — treating it as
 * `stale` (vs 'failed') signals to the Today UI that it's no longer
 * part of this week's plan without flagging it as a system error.
 */
const STALE_AFTER_HOURS = 24;

/**
 * How long after `createdAt` a pending reply draft can sit before we
 * mark it `skipped`. Same 24h window as plan_items; mirrors the rule
 * that a draft the founder ignored through a full day is no longer
 * actionable. Replies older than this are at risk of replying to a
 * deleted/hidden target tweet — X compose silently drops those to X
 * Drafts, which is what the founder reported as "edit-then-send-reply
 * becomes drafts not reply".
 */
const DRAFTS_STALE_AFTER_HOURS = 24;

/**
 * Every-hour cron. Marks planned items past scheduledAt + 24h as
 * stale. Approved items that sat unexecuted past their window get
 * the same treatment — an approved post that never went out is a
 * broken execute path, not a live plan_item.
 *
 * Terminal states (completed/failed/skipped/superseded/stale) are
 * untouched. Drafted / ready_for_review are left alone because the
 * founder is actively reviewing them; only `planned` + `approved`
 * rows that the pipeline is waiting on fall into the stale bucket.
 */
export async function processStaleSweeper(
  job: Job<Record<string, never>>,
): Promise<void> {
  const jlog = loggerForJob(log, job);
  const cutoff = new Date(Date.now() - STALE_AFTER_HOURS * 60 * 60 * 1000);

  const markedPlanned = await db
    .update(planItems)
    .set({ state: 'stale', updatedAt: sql`now()` })
    .where(
      and(
        eq(planItems.state, 'planned'),
        lt(planItems.scheduledAt, cutoff),
      ),
    )
    .returning({ id: planItems.id, userId: planItems.userId });

  const markedApproved = await db
    .update(planItems)
    .set({ state: 'stale', updatedAt: sql`now()` })
    .where(
      and(
        eq(planItems.state, 'approved'),
        lt(planItems.scheduledAt, cutoff),
      ),
    )
    .returning({ id: planItems.id, userId: planItems.userId });

  const draftsCutoff = new Date(
    Date.now() - DRAFTS_STALE_AFTER_HOURS * 60 * 60 * 1000,
  );
  const markedDrafts = await db
    .update(drafts)
    .set({ status: 'skipped', updatedAt: sql`now()` })
    .where(
      and(
        eq(drafts.status, 'pending'),
        lt(drafts.createdAt, draftsCutoff),
      ),
    )
    .returning({ id: drafts.id, userId: drafts.userId });

  // Emit a per-user aggregate event (planned + approved + drafts
  // staleness lumped together) so the pipeline_events feed shows the
  // cron ran and which users had rows expire.
  const perUser = new Map<
    string,
    { planned: number; approved: number; drafts: number }
  >();
  for (const r of markedPlanned) {
    const cur = perUser.get(r.userId) ?? { planned: 0, approved: 0, drafts: 0 };
    cur.planned++;
    perUser.set(r.userId, cur);
  }
  for (const r of markedApproved) {
    const cur = perUser.get(r.userId) ?? { planned: 0, approved: 0, drafts: 0 };
    cur.approved++;
    perUser.set(r.userId, cur);
  }
  for (const r of markedDrafts) {
    const cur = perUser.get(r.userId) ?? { planned: 0, approved: 0, drafts: 0 };
    cur.drafts++;
    perUser.set(r.userId, cur);
  }
  if (perUser.size > 0) {
    await recordPipelineEventsBulk(
      [...perUser.entries()].map(([userId, counts]) => ({
        userId,
        stage: 'sweeper_run',
        metadata: {
          sweeper: 'stale',
          plannedMarked: counts.planned,
          approvedMarked: counts.approved,
          draftsMarked: counts.drafts,
        },
      })),
    );
  }

  jlog.info(
    `staleness sweep: marked ${markedPlanned.length} planned + ${markedApproved.length} approved + ${markedDrafts.length} drafts as stale across ${perUser.size} users (cutoffs plan=${cutoff.toISOString()} drafts=${draftsCutoff.toISOString()})`,
  );
}
