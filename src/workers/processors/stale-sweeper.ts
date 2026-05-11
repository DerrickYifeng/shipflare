import type { Job } from 'bullmq';
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { drafts, planItems } from '@/lib/db/schema';
import { recordPipelineEventsBulk } from '@/lib/pipeline-events';
import { createLogger, loggerForJob } from '@/lib/logger';

const log = createLogger('worker:stale-sweeper');

/**
 * How long after `createdAt` a pending reply draft can sit before we
 * mark it `skipped`. 24h mirrors the rule that a draft the founder
 * ignored through a full day is no longer actionable. Replies older
 * than this are at risk of replying to a deleted/hidden target tweet.
 */
const DRAFTS_STALE_AFTER_HOURS = 24;

/**
 * Every-hour cron. Marks planned / approved plan_items whose dueDate
 * is before today as stale. Terminal states (completed/failed/skipped/
 * superseded/stale) are untouched. Drafted / ready_for_review rows
 * are left alone — the founder is actively reviewing them.
 */
export async function processStaleSweeper(
  job: Job<Record<string, never>>,
): Promise<void> {
  const jlog = loggerForJob(log, job);
  // Midnight UTC today — items due strictly before this are past.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const markedPlanned = await db
    .update(planItems)
    .set({ state: 'stale', updatedAt: sql`now()` })
    .where(
      and(
        eq(planItems.state, 'planned'),
        lt(planItems.dueDate, today),
      ),
    )
    .returning({ id: planItems.id, userId: planItems.userId });

  const markedApproved = await db
    .update(planItems)
    .set({ state: 'stale', updatedAt: sql`now()` })
    .where(
      and(
        eq(planItems.state, 'approved'),
        lt(planItems.dueDate, today),
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
    `staleness sweep: marked ${markedPlanned.length} planned + ${markedApproved.length} approved + ${markedDrafts.length} drafts as stale across ${perUser.size} users (today=${today.toISOString()} draftsCutoff=${draftsCutoff.toISOString()})`,
  );
}
