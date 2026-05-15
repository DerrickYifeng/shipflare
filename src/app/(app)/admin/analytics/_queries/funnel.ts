import { sql, and, gte, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  waitlistSignups,
  users,
  pipelineEvents,
  posts,
} from '@/lib/db/schema';

export interface FunnelCounts {
  waitlistSignups: number;
  approvedAllowlisted: number;
  signedUp: number;
  ranFirstScan: number;
  publishedFirstPost: number;
}

export interface FunnelOptions {
  now?: Date;
  windowDays?: number;
}

/**
 * Five-stage alpha funnel over the last `windowDays`:
 *
 *   waitlist signups → approved → first sign-in → first scan → first post
 *
 * Each stage is an independent count; conversion % is computed in the UI.
 * All five queries run in parallel via Promise.all.
 *
 * Note: pipelineEvents uses `enteredAt` (not `createdAt`) as its timestamp
 * column. Stage 'discovered' corresponds to the first scan discovery event.
 */
export async function getFunnel(opts: FunnelOptions = {}): Promise<FunnelCounts> {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 30;
  const since = new Date(now.getTime() - windowDays * 86400_000);

  const [
    [{ count: waitlistCount }],
    [{ count: approvedCount }],
    [{ count: signedUpCount }],
    [{ count: scanCount }],
    [{ count: postCount }],
  ] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(waitlistSignups)
      .where(gte(waitlistSignups.createdAt, since)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(waitlistSignups)
      .where(
        and(
          isNotNull(waitlistSignups.approvedAt),
          gte(waitlistSignups.approvedAt, since),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(gte(users.createdAt, since)),
    db
      .select({
        count: sql<number>`count(distinct ${pipelineEvents.userId})::int`,
      })
      .from(pipelineEvents)
      .where(
        and(
          eq(pipelineEvents.stage, 'discovered'),
          gte(pipelineEvents.enteredAt, since),
        ),
      ),
    db
      .select({ count: sql<number>`count(distinct ${posts.userId})::int` })
      .from(posts)
      .where(and(eq(posts.status, 'posted'), gte(posts.postedAt, since))),
  ]);

  return {
    waitlistSignups: Number(waitlistCount),
    approvedAllowlisted: Number(approvedCount),
    signedUp: Number(signedUpCount),
    ranFirstScan: Number(scanCount),
    publishedFirstPost: Number(postCount),
  };
}
