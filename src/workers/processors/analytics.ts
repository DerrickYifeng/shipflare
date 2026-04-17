import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import {
  channels,
  posts,
  xTweetMetrics,
  xFollowerSnapshots,
  xContentCalendar,
  xAnalyticsSummary,
  activityEvents,
} from '@/lib/db/schema';
import { eq, and, gte } from 'drizzle-orm';
import { publishUserEvent } from '@/lib/redis';
import { enqueueAnalytics } from '@/lib/queue';
import type { AnalyticsJobData } from '@/lib/queue/types';
import { isFanoutJob } from '@/lib/queue/types';
import { createLogger, loggerForJob, type Logger } from '@/lib/logger';

const baseLog = createLogger('worker:x-analytics');

const ANALYTICS_LOOKBACK_DAYS = 30;

async function processXAnalyticsForUser(userId: string, log: Logger) {
  log.info(`Computing X analytics for user ${userId}`);

  const periodEnd = new Date();
  const periodStart = new Date(
    Date.now() - ANALYTICS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );

  // Fetch all metrics in the period
  const metrics = await db
    .select({
      tweetId: xTweetMetrics.tweetId,
      impressions: xTweetMetrics.impressions,
      likes: xTweetMetrics.likes,
      retweets: xTweetMetrics.retweets,
      replies: xTweetMetrics.replies,
      bookmarks: xTweetMetrics.bookmarks,
      sampledAt: xTweetMetrics.sampledAt,
    })
    .from(xTweetMetrics)
    .where(
      and(
        eq(xTweetMetrics.userId, userId),
        gte(xTweetMetrics.sampledAt, periodStart),
      ),
    );

  if (metrics.length === 0) {
    log.info('No metrics data to analyze');
    return;
  }

  // Dedupe: keep the latest sample per tweet
  const latestByTweet = new Map<
    string,
    (typeof metrics)[number]
  >();
  for (const m of metrics) {
    const existing = latestByTweet.get(m.tweetId);
    if (!existing || m.sampledAt > existing.sampledAt) {
      latestByTweet.set(m.tweetId, m);
    }
  }
  const uniqueMetrics = [...latestByTweet.values()];

  // Map tweetId → contentType via posts + xContentCalendar
  const postRecords = await db
    .select({
      externalId: posts.externalId,
      draftId: posts.draftId,
      postedAt: posts.postedAt,
    })
    .from(posts)
    .where(eq(posts.userId, userId));

  const draftIds = postRecords
    .map((p) => p.draftId)
    .filter((id): id is string => !!id);

  const calendarItems =
    draftIds.length > 0
      ? await db
          .select({
            draftId: xContentCalendar.draftId,
            contentType: xContentCalendar.contentType,
          })
          .from(xContentCalendar)
          .where(eq(xContentCalendar.userId, userId))
      : [];

  // Build lookup maps
  const tweetToPost = new Map(
    postRecords
      .filter((p) => p.externalId)
      .map((p) => [p.externalId!, p]),
  );
  const draftToContentType = new Map(
    calendarItems
      .filter((c) => c.draftId)
      .map((c) => [c.draftId!, c.contentType]),
  );

  // Compute best content types
  const contentTypeStats = new Map<
    string,
    { totalBookmarks: number; totalImpressions: number; count: number }
  >();

  for (const m of uniqueMetrics) {
    const post = tweetToPost.get(m.tweetId);
    const contentType = post
      ? draftToContentType.get(post.draftId) ?? 'unknown'
      : 'unknown';

    const stats = contentTypeStats.get(contentType) ?? {
      totalBookmarks: 0,
      totalImpressions: 0,
      count: 0,
    };
    stats.totalBookmarks += m.bookmarks;
    stats.totalImpressions += m.impressions;
    stats.count += 1;
    contentTypeStats.set(contentType, stats);
  }

  const bestContentTypes = [...contentTypeStats.entries()]
    .map(([type, stats]) => ({
      type,
      avgBookmarks: stats.count > 0 ? stats.totalBookmarks / stats.count : 0,
      avgImpressions:
        stats.count > 0 ? stats.totalImpressions / stats.count : 0,
      count: stats.count,
    }))
    .sort((a, b) => b.avgBookmarks - a.avgBookmarks);

  // Compute best posting hours
  const hourStats = new Map<
    number,
    { totalEngagement: number; count: number }
  >();

  for (const m of uniqueMetrics) {
    const post = tweetToPost.get(m.tweetId);
    const hour = post ? post.postedAt.getUTCHours() : -1;
    if (hour < 0) continue;

    const engagement = m.likes + m.bookmarks + m.replies + m.retweets;
    const stats = hourStats.get(hour) ?? { totalEngagement: 0, count: 0 };
    stats.totalEngagement += engagement;
    stats.count += 1;
    hourStats.set(hour, stats);
  }

  const bestPostingHours = [...hourStats.entries()]
    .map(([hour, stats]) => ({
      hour,
      avgEngagement:
        stats.count > 0 ? stats.totalEngagement / stats.count : 0,
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement);

  // Compute audience growth rate
  const snapshots = await db
    .select({
      followerCount: xFollowerSnapshots.followerCount,
      snapshotAt: xFollowerSnapshots.snapshotAt,
    })
    .from(xFollowerSnapshots)
    .where(
      and(
        eq(xFollowerSnapshots.userId, userId),
        gte(xFollowerSnapshots.snapshotAt, periodStart),
      ),
    )
    .orderBy(xFollowerSnapshots.snapshotAt);

  let audienceGrowthRate = 0;
  if (snapshots.length >= 2) {
    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    const daysDiff =
      (last.snapshotAt.getTime() - first.snapshotAt.getTime()) /
      (1000 * 60 * 60 * 24);
    if (daysDiff > 0) {
      audienceGrowthRate =
        (last.followerCount - first.followerCount) / daysDiff;
    }
  }

  // Compute overall engagement rate
  const totalImpressions = uniqueMetrics.reduce(
    (sum, m) => sum + m.impressions,
    0,
  );
  const totalEngagement = uniqueMetrics.reduce(
    (sum, m) => sum + m.likes + m.bookmarks + m.replies,
    0,
  );
  const totalBookmarks = uniqueMetrics.reduce(
    (sum, m) => sum + m.bookmarks,
    0,
  );
  const engagementRate =
    totalImpressions > 0 ? totalEngagement / totalImpressions : 0;

  await db
    .insert(xAnalyticsSummary)
    .values({
      userId,
      periodStart,
      periodEnd,
      bestContentTypes,
      bestPostingHours,
      audienceGrowthRate,
      engagementRate,
      totalImpressions,
      totalBookmarks,
    })
    .onConflictDoUpdate({
      target: [
        xAnalyticsSummary.userId,
        xAnalyticsSummary.periodStart,
        xAnalyticsSummary.periodEnd,
      ],
      set: {
        bestContentTypes,
        bestPostingHours,
        audienceGrowthRate,
        engagementRate,
        totalImpressions,
        totalBookmarks,
        computedAt: new Date(),
      },
    });

  log.info(
    `Analytics computed: ${uniqueMetrics.length} tweets, engagement rate ${(engagementRate * 100).toFixed(2)}%, growth ${audienceGrowthRate.toFixed(1)}/day`,
  );

  // Publish SSE event
  await publishUserEvent(userId, 'agents', {
    type: 'analytics_computed',
    tweetsAnalyzed: uniqueMetrics.length,
    engagementRate,
    audienceGrowthRate,
  });

  // Log activity
  await db.insert(activityEvents).values({
    userId,
    eventType: 'x_analytics_computed',
    metadataJson: {
      tweetsAnalyzed: uniqueMetrics.length,
      engagementRate,
      audienceGrowthRate,
      topContentType: bestContentTypes[0]?.type ?? 'unknown',
    },
  });
}

export async function processXAnalytics(job: Job<AnalyticsJobData>) {
  const log = loggerForJob(baseLog, job);
  if (isFanoutJob(job.data)) {
    const platform = (job.data as { platform?: string }).platform ?? 'x';
    // Cron fan-out: enqueue per-user analytics jobs.
    const xChannels = await db
      .select({ userId: channels.userId })
      .from(channels)
      .where(eq(channels.platform, platform));

    const userIds = [...new Set(xChannels.map((c) => c.userId))];
    log.info(
      `Cron fan-out: enqueueing ${userIds.length} per-user analytics jobs (${platform})`,
    );

    for (const uid of userIds) {
      await enqueueAnalytics({ userId: uid, platform });
    }
    return;
  }

  const data = job.data as Extract<AnalyticsJobData, { userId: string }>;
  await processXAnalyticsForUser(data.userId, log);
}
