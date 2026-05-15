import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

export interface CohortRow {
  cohortStart: string; // yyyy-mm-dd of week start
  cohortSize: number;
  // Index N = retention in week N (W0 = signup week, W1 = 7-13 days after, etc.)
  weeklyRetention: number[]; // counts of returning users, not percentages
}

export interface RetentionResult {
  cohorts: CohortRow[];
  nDayRetention: { d1: number; d7: number; d14: number }; // 0..1
  dauWauRatio: number; // 0..1
}

/**
 * Retention based on "meaningful action" = scan, draft, OR post.
 *
 *   meaningful_action_days = SELECT DISTINCT user_id, date_trunc('day', t)::date AS day
 *     FROM (
 *       SELECT user_id, entered_at AS t FROM pipeline_events WHERE stage='discovered'
 *       UNION ALL
 *       SELECT user_id, created_at AS t FROM drafts
 *       UNION ALL
 *       SELECT user_id, posted_at AS t FROM posts WHERE status='posted' AND posted_at IS NOT NULL
 *     ) x;
 *
 * Cohorts are weekly buckets starting from windowDays days ago.
 */
export async function getRetention(
  opts: { now?: Date; windowDays?: number } = {},
): Promise<RetentionResult> {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 30;
  const since = new Date(now.getTime() - windowDays * 86400_000);

  // The CTE is reused 3 times → declare via a SQL fragment.
  const actionsCte = sql`
    WITH meaningful_action_days AS (
      SELECT user_id, date_trunc('day', t)::date AS day FROM (
        SELECT user_id, entered_at AS t FROM pipeline_events
          WHERE stage = 'discovered'
        UNION ALL
        SELECT user_id, created_at AS t FROM drafts
        UNION ALL
        SELECT user_id, posted_at AS t FROM posts
          WHERE status = 'posted' AND posted_at IS NOT NULL
      ) x
      GROUP BY user_id, date_trunc('day', t)::date
    )
  `;

  // Cohort retention: for each weekly cohort starting in the window,
  // count distinct users active in each week-offset (W0..W3).
  const cohortRowsRaw = await db.execute(sql`
    ${actionsCte},
    cohorts AS (
      SELECT
        date_trunc('week', created_at)::date AS cohort_start,
        id AS user_id
      FROM users
      WHERE created_at >= ${since.toISOString()}::timestamptz
    )
    SELECT
      c.cohort_start,
      count(DISTINCT c.user_id)::int AS cohort_size,
      count(DISTINCT CASE
        WHEN m.day - c.cohort_start BETWEEN 0 AND 6 THEN m.user_id END)::int AS w0,
      count(DISTINCT CASE
        WHEN m.day - c.cohort_start BETWEEN 7 AND 13 THEN m.user_id END)::int AS w1,
      count(DISTINCT CASE
        WHEN m.day - c.cohort_start BETWEEN 14 AND 20 THEN m.user_id END)::int AS w2,
      count(DISTINCT CASE
        WHEN m.day - c.cohort_start BETWEEN 21 AND 27 THEN m.user_id END)::int AS w3
    FROM cohorts c
    LEFT JOIN meaningful_action_days m USING (user_id)
    GROUP BY c.cohort_start
    ORDER BY c.cohort_start ASC
  `);

  const cohortRows = cohortRowsRaw as unknown as Array<{
    cohort_start: string | Date;
    cohort_size: number;
    w0: number;
    w1: number;
    w2: number;
    w3: number;
  }>;

  const cohorts: CohortRow[] = cohortRows.map((r) => ({
    cohortStart:
      r.cohort_start instanceof Date
        ? r.cohort_start.toISOString().slice(0, 10)
        : String(r.cohort_start).slice(0, 10),
    cohortSize: Number(r.cohort_size),
    weeklyRetention: [r.w0, r.w1, r.w2, r.w3].map(Number),
  }));

  // N-day retention: of users who signed up at least N days ago,
  // what fraction had a meaningful action by day N?
  const nDayRowsRaw = await db.execute(sql`
    ${actionsCte},
    eligible AS (
      SELECT id, created_at
      FROM users
      WHERE created_at >= ${since.toISOString()}::timestamptz
    )
    SELECT
      sum(CASE WHEN now() - e.created_at >= interval '1 day' THEN 1 ELSE 0 END)::int AS e_d1,
      sum(CASE WHEN now() - e.created_at >= interval '1 day' AND EXISTS (
        SELECT 1 FROM meaningful_action_days m
        WHERE m.user_id = e.id AND m.day - e.created_at::date <= 1
      ) THEN 1 ELSE 0 END)::int AS r_d1,

      sum(CASE WHEN now() - e.created_at >= interval '7 days' THEN 1 ELSE 0 END)::int AS e_d7,
      sum(CASE WHEN now() - e.created_at >= interval '7 days' AND EXISTS (
        SELECT 1 FROM meaningful_action_days m
        WHERE m.user_id = e.id AND m.day - e.created_at::date <= 7
      ) THEN 1 ELSE 0 END)::int AS r_d7,

      sum(CASE WHEN now() - e.created_at >= interval '14 days' THEN 1 ELSE 0 END)::int AS e_d14,
      sum(CASE WHEN now() - e.created_at >= interval '14 days' AND EXISTS (
        SELECT 1 FROM meaningful_action_days m
        WHERE m.user_id = e.id AND m.day - e.created_at::date <= 14
      ) THEN 1 ELSE 0 END)::int AS r_d14
    FROM eligible e
  `);

  const nDayRows = nDayRowsRaw as unknown as Array<{
    e_d1: number; r_d1: number;
    e_d7: number; r_d7: number;
    e_d14: number; r_d14: number;
  }>;

  const n = nDayRows[0] ?? { e_d1: 0, r_d1: 0, e_d7: 0, r_d7: 0, e_d14: 0, r_d14: 0 };
  const nDayRetention = {
    d1: Number(n.e_d1) > 0 ? Number(n.r_d1) / Number(n.e_d1) : 0,
    d7: Number(n.e_d7) > 0 ? Number(n.r_d7) / Number(n.e_d7) : 0,
    d14: Number(n.e_d14) > 0 ? Number(n.r_d14) / Number(n.e_d14) : 0,
  };

  // DAU/WAU: distinct active users last 1d / distinct active users last 7d.
  const dauWauRowRaw = await db.execute(sql`
    ${actionsCte}
    SELECT
      count(DISTINCT CASE WHEN day >= (now() - interval '1 day')::date THEN user_id END)::int AS dau,
      count(DISTINCT CASE WHEN day >= (now() - interval '7 days')::date THEN user_id END)::int AS wau
    FROM meaningful_action_days
  `);

  const dauWauRow = dauWauRowRaw as unknown as Array<{ dau: number; wau: number }>;
  const { dau = 0, wau = 0 } = dauWauRow[0] ?? {};
  const dauWauRatio = Number(wau) > 0 ? Number(dau) / Number(wau) : 0;

  return { cohorts, nDayRetention, dauWauRatio };
}
