import { sql, and, gte, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  waitlistSignups,
  users,
  pipelineEvents,
  drafts,
  posts,
} from '@/lib/db/schema';

export interface DailyActivity {
  /** Oldest-first day buckets, length = windowDays. */
  days: string[]; // ISO yyyy-mm-dd
  waitlistSignups: number[];
  signins: number[];
  scans: number[];
  drafts: number[];
  postsPublished: number[];
  approvals: number[];
}

export async function getDailyActivity(
  opts: { now?: Date; windowDays?: number } = {},
): Promise<DailyActivity> {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 30;
  const since = new Date(now.getTime() - windowDays * 86400_000);

  // Generate the day buckets in JS so empty days still appear as 0.
  const days: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400_000);
    days.push(d.toISOString().slice(0, 10));
  }

  // For each metric, get { day, count } rows from PG via date_trunc,
  // then zip into the days array.
  const [waitlistRows, signinRows, scanRows, draftRows, postRows, approvalRows] =
    await Promise.all([
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${waitlistSignups.createdAt}), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(waitlistSignups)
        .where(gte(waitlistSignups.createdAt, since))
        .groupBy(sql`date_trunc('day', ${waitlistSignups.createdAt})`),
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${users.lastLoginAt}), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(users)
        .where(and(isNotNull(users.lastLoginAt), gte(users.lastLoginAt, since)))
        .groupBy(sql`date_trunc('day', ${users.lastLoginAt})`),
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${pipelineEvents.enteredAt}), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(pipelineEvents)
        .where(
          and(
            eq(pipelineEvents.stage, 'discovered'),
            gte(pipelineEvents.enteredAt, since),
          ),
        )
        .groupBy(sql`date_trunc('day', ${pipelineEvents.enteredAt})`),
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${drafts.createdAt}), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(drafts)
        .where(gte(drafts.createdAt, since))
        .groupBy(sql`date_trunc('day', ${drafts.createdAt})`),
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${posts.postedAt}), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(posts)
        .where(and(eq(posts.status, 'posted'), gte(posts.postedAt, since)))
        .groupBy(sql`date_trunc('day', ${posts.postedAt})`),
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${waitlistSignups.approvedAt}), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(waitlistSignups)
        .where(
          and(
            isNotNull(waitlistSignups.approvedAt),
            gte(waitlistSignups.approvedAt, since),
          ),
        )
        .groupBy(sql`date_trunc('day', ${waitlistSignups.approvedAt})`),
    ]);

  function zip(rows: Array<{ day: string; count: number }>): number[] {
    const m = new Map(rows.map((r) => [r.day, Number(r.count)]));
    return days.map((d) => m.get(d) ?? 0);
  }

  return {
    days,
    waitlistSignups: zip(waitlistRows),
    signins: zip(signinRows),
    scans: zip(scanRows),
    drafts: zip(draftRows),
    postsPublished: zip(postRows),
    approvals: zip(approvalRows),
  };
}
