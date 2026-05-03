import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { posts, drafts, pipelineEvents } from '@/lib/db/schema';

export interface PartnerActivityCounts {
  posts7d: number; // original posts shipped in last 7d
  replies7d: number; // replies shipped in last 7d
  scans7d: number; // discovered threads in last 7d (Discovery agent activity)
}

const ZERO: PartnerActivityCounts = { posts7d: 0, replies7d: 0, scans7d: 0 };

/**
 * Batched 7-day activity counts per user. Three SELECTs run in
 * parallel via Promise.all; each returns rows keyed by userId so the
 * page can render the same cells in O(1) lookup time.
 *
 * "Posts" and "Replies" are split by `drafts.draft_type` ('original_post'
 * vs 'reply') joined through `posts.draft_id` — the join filters out
 * any drafts that never shipped.
 *
 * "Scans" use `pipeline_events.stage = 'discovered'` rather than
 * `activity_events`, because discovered threads are the per-user
 * Discovery-agent activity signal that is reliably written.
 */
export async function getPartnerActivityCounts(
  userIds: string[],
): Promise<Map<string, PartnerActivityCounts>> {
  const out = new Map<string, PartnerActivityCounts>();
  if (userIds.length === 0) return out;

  for (const id of userIds) out.set(id, { ...ZERO });

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [postRows, replyRows, scanRows] = await Promise.all([
    // Original posts
    db
      .select({
        userId: posts.userId,
        count: sql<number>`COUNT(*)::int`.as('count'),
      })
      .from(posts)
      .innerJoin(drafts, eq(posts.draftId, drafts.id))
      .where(
        and(
          inArray(posts.userId, userIds),
          gte(posts.postedAt, sevenDaysAgo),
          eq(drafts.draftType, 'original_post'),
        ),
      )
      .groupBy(posts.userId),

    // Replies
    db
      .select({
        userId: posts.userId,
        count: sql<number>`COUNT(*)::int`.as('count'),
      })
      .from(posts)
      .innerJoin(drafts, eq(posts.draftId, drafts.id))
      .where(
        and(
          inArray(posts.userId, userIds),
          gte(posts.postedAt, sevenDaysAgo),
          eq(drafts.draftType, 'reply'),
        ),
      )
      .groupBy(posts.userId),

    // Scans (discovery)
    db
      .select({
        userId: pipelineEvents.userId,
        count: sql<number>`COUNT(*)::int`.as('count'),
      })
      .from(pipelineEvents)
      .where(
        and(
          inArray(pipelineEvents.userId, userIds),
          gte(pipelineEvents.enteredAt, sevenDaysAgo),
          eq(pipelineEvents.stage, 'discovered'),
        ),
      )
      .groupBy(pipelineEvents.userId),
  ]);

  for (const r of postRows) {
    const cur = out.get(r.userId);
    if (cur) cur.posts7d = Number(r.count);
  }
  for (const r of replyRows) {
    const cur = out.get(r.userId);
    if (cur) cur.replies7d = Number(r.count);
  }
  for (const r of scanRows) {
    const cur = out.get(r.userId);
    if (cur) cur.scans7d = Number(r.count);
  }

  return out;
}
