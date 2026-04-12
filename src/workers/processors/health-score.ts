import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { drafts, posts, activityEvents, healthScores } from '@/lib/db/schema';
import { eq, and, gte, sql } from 'drizzle-orm';
import type { HealthScoreJobData } from '@/lib/queue/types';

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
  const { userId } = job.data;
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // S1: Pipeline activity (discovery scans + drafts created in last 7 days)
  const recentDrafts = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.userId, userId), gte(drafts.createdAt, weekAgo)));

  const draftCount = recentDrafts.length;
  const s1 = Math.min(1.0, draftCount / 10); // 10 drafts/week = 100%

  // S2: Average confidence of recent drafts
  const avgConfidence =
    draftCount > 0
      ? recentDrafts.reduce((sum, d) => sum + d.confidenceScore, 0) /
        draftCount
      : 0;
  const s2 = avgConfidence;

  // S3: Engagement (posts with verified status in last 7 days)
  const recentPosts = await db
    .select()
    .from(posts)
    .where(and(eq(posts.userId, userId), gte(posts.postedAt, weekAgo)));

  const verifiedCount = recentPosts.filter(
    (p) => p.status === 'verified',
  ).length;
  const postCount = recentPosts.length;
  const ENGAGEMENT_BASELINE = 20; // Hardcoded for Phase 1
  const s3 = postCount > 0 ? Math.min(1.0, verifiedCount / ENGAGEMENT_BASELINE) : 0;

  // S4: Consistency (posting regularity, only if >= 5 total drafts)
  const allDrafts = await db
    .select()
    .from(drafts)
    .where(eq(drafts.userId, userId));

  const totalDrafts = allDrafts.length;
  const isColdStart = totalDrafts < 5;

  let s4 = 0;
  if (!isColdStart) {
    // Days with at least one post in last 7 days
    const uniqueDays = new Set(
      recentPosts.map((p) => p.postedAt.toISOString().slice(0, 10)),
    );
    s4 = Math.min(1.0, uniqueDays.size / 5); // 5 active days = 100%
  }

  // S5: Safety (no circuit breaker trips in last 7 days)
  const breakerTrips = await db
    .select()
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.userId, userId),
        eq(activityEvents.eventType, 'circuit_breaker_trip'),
        gte(activityEvents.createdAt, weekAgo),
      ),
    );

  const s5 = breakerTrips.length === 0 ? 1.0 : 0.0;

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
