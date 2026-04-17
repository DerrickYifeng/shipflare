import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { drafts, posts, activityEvents, healthScores } from '@/lib/db/schema';
import { eq, and, gte, sql } from 'drizzle-orm';
import type { HealthScoreJobData } from '@/lib/queue/types';
import { createLogger, loggerForJob } from '@/lib/logger';

const baseLog = createLogger('worker:health-score');

/**
 * Calculate Health Score for a user. Pure SQL, no LLM.
 *
 * S1 Pipeline (25%): Are discovery scans running and producing drafts?
 * S2 Quality (20%): Average confidence score of drafts.
 * S3 Engagement (20%): Post engagement relative to baseline (hardcoded 20 for Phase 1).
 * S4 Consistency (20%): Are posts happening regularly? (excluded if < 5 drafts)
 * S5 Safety (15%): No circuit breaker trips, no shadowbans.
 */
export async function processHealthScore(job: Job<HealthScoreJobData>) {
  const log = loggerForJob(baseLog, job);
  const { userId } = job.data;
  log.info(`Calculating health score for user ${userId}`);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // S1 + S2: recent drafts count + average confidence (last 7 days).
  // SQL aggregate replaces the old SELECT * + JS reduce.
  const [draftAgg] = await db
    .select({
      count: sql<number>`count(*)::int`,
      avgConfidence: sql<number | null>`avg(${drafts.confidenceScore})::real`,
    })
    .from(drafts)
    .where(and(eq(drafts.userId, userId), gte(drafts.createdAt, weekAgo)));

  const draftCount = draftAgg?.count ?? 0;
  const s1 = Math.min(1.0, draftCount / 10); // 10 drafts/week = 100%
  const s2 = draftAgg?.avgConfidence ?? 0;

  // S3 + S4 (partial): recent post aggregates (last 7 days).
  //   postCount         — total posts in window (for S3 gate)
  //   verifiedCount     — posts with status='verified' (S3 numerator)
  //   activeDayCount    — distinct calendar days with ≥1 post (S4 numerator)
  // One round-trip instead of SELECT * + JS filter/Set.
  const [postAgg] = await db
    .select({
      count: sql<number>`count(*)::int`,
      verifiedCount: sql<number>`count(*) filter (where ${posts.status} = 'verified')::int`,
      activeDayCount: sql<number>`count(distinct date_trunc('day', ${posts.postedAt}))::int`,
    })
    .from(posts)
    .where(and(eq(posts.userId, userId), gte(posts.postedAt, weekAgo)));

  const postCount = postAgg?.count ?? 0;
  const verifiedCount = postAgg?.verifiedCount ?? 0;
  const activeDayCount = postAgg?.activeDayCount ?? 0;
  const ENGAGEMENT_BASELINE = 20; // Hardcoded for Phase 1
  const s3 = postCount > 0 ? Math.min(1.0, verifiedCount / ENGAGEMENT_BASELINE) : 0;

  // S4 gate: lifetime draft count (unbounded by time — the "cold start" test).
  const [allDraftAgg] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(drafts)
    .where(eq(drafts.userId, userId));

  const totalDrafts = allDraftAgg?.count ?? 0;
  const isColdStart = totalDrafts < 5;

  let s4 = 0;
  if (!isColdStart) {
    // Days with at least one post in last 7 days — from SQL aggregate above.
    s4 = Math.min(1.0, activeDayCount / 5); // 5 active days = 100%
  }

  // S5: Safety (no circuit breaker trips in last 7 days)
  const [breakerAgg] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.userId, userId),
        eq(activityEvents.eventType, 'circuit_breaker_trip'),
        gte(activityEvents.createdAt, weekAgo),
      ),
    );

  const s5 = (breakerAgg?.count ?? 0) === 0 ? 1.0 : 0.0;

  // Weighted score
  let score: number;
  if (isColdStart) {
    // Exclude S4, redistribute weight
    score = Math.round(
      (s1 * 0.30 + s2 * 0.25 + s3 * 0.25 + s5 * 0.20) * 100,
    );
  } else {
    score = Math.round(
      (s1 * 0.25 + s2 * 0.20 + s3 * 0.20 + s4 * 0.20 + s5 * 0.15) * 100,
    );
  }

  score = Math.max(0, Math.min(100, score));

  log.info(`Health score: ${score} (S1=${(s1 * 100).toFixed(0)} S2=${(s2 * 100).toFixed(0)} S3=${(s3 * 100).toFixed(0)} S4=${(s4 * 100).toFixed(0)} S5=${(s5 * 100).toFixed(0)})`);

  // Insert health score
  await db.insert(healthScores).values({
    userId,
    score,
    s1Pipeline: s1,
    s2Quality: s2,
    s3Engagement: s3,
    s4Consistency: s4,
    s5Safety: s5,
  });
}
