import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import {
  channels,
  posts,
  activityEvents,
  xTweetMetrics,
  xFollowerSnapshots,
} from '@/lib/db/schema';
import { eq, and, gte } from 'drizzle-orm';
import { XClient, XForbiddenError } from '@/lib/x-client';
import { createPlatformDeps } from '@/lib/platform-deps';
import { publishUserEvent } from '@/lib/redis';
import { enqueueMetrics } from '@/lib/queue';
import type { MetricsJobData } from '@/lib/queue/types';
import { isFanoutJob } from '@/lib/queue/types';
import { createLogger, loggerForJob, type Logger } from '@/lib/logger';

const baseLog = createLogger('worker:x-metrics');

const METRICS_LOOKBACK_DAYS = 7;
const BATCH_SIZE = 100;

async function processXMetricsForUser(userId: string, log: Logger) {
  log.info(`Collecting X metrics for user ${userId}`);

  // Resolve X client via createPlatformDeps — sanctioned path for token-column
  // access (see CLAUDE.md → Security TODO item 2).
  const deps = await createPlatformDeps('x', userId);
  const xClient = deps.xClient as XClient | undefined;
  if (!xClient) throw new Error('No X channel connected');

  // Snapshot follower count (one per UTC day; skip if already recorded today)
  try {
    const me = await xClient.getMe();
    if (me.publicMetrics) {
      const snapshotDate = new Date().toISOString().slice(0, 10);
      await db
        .insert(xFollowerSnapshots)
        .values({
          userId,
          followerCount: me.publicMetrics.followersCount,
          followingCount: me.publicMetrics.followingCount,
          tweetCount: me.publicMetrics.tweetCount,
          snapshotDate,
        })
        .onConflictDoNothing();
      log.info(
        `Follower snapshot: ${me.publicMetrics.followersCount} followers`,
      );
    }
  } catch (err) {
    log.error(`Failed to snapshot follower count: ${err}`);
  }

  // Collect metrics for recent posts
  const lookbackDate = new Date(
    Date.now() - METRICS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );

  const recentPosts = await db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.userId, userId),
        eq(posts.platform, 'x'),
        gte(posts.postedAt, lookbackDate),
      ),
    );

  // Only X posts with external IDs are eligible for metrics collection
  const xPosts = recentPosts.filter(
    (p): p is typeof p & { externalId: string } => p.externalId !== null,
  );

  if (xPosts.length === 0) {
    log.info('No recent X posts to collect metrics for');
    return;
  }

  log.info(`Collecting metrics for ${xPosts.length} recent X posts`);

  // Batch-fetch metrics
  let metricsCollected = 0;

  try {
    for (let i = 0; i < xPosts.length; i += BATCH_SIZE) {
      const batch = xPosts.slice(i, i + BATCH_SIZE);
      const tweetIds = batch
        .map((p) => p.externalId)
        .filter((id): id is string => id !== null);

      const tweets = await xClient.getTweets(tweetIds);

      for (const tweet of tweets) {
        if (!tweet.metrics) continue;

        await db.insert(xTweetMetrics).values({
          userId,
          tweetId: tweet.id,
          impressions: tweet.metrics.impressions,
          likes: tweet.metrics.likes,
          retweets: tweet.metrics.retweets,
          replies: tweet.metrics.replies,
          bookmarks: tweet.metrics.bookmarks,
          quoteTweets: tweet.metrics.quotes,
        });

        metricsCollected++;
      }
    }
  } catch (err) {
    if (err instanceof XForbiddenError) {
      log.warn(
        'X API 403 — Basic tier required for tweet metrics. Skipping metrics collection.',
      );
    } else {
      throw err;
    }
  }

  log.info(`Collected metrics for ${metricsCollected} tweets`);

  // Publish SSE event
  await publishUserEvent(userId, 'agents', {
    type: 'agent_complete',
    agentName: 'x-metrics',
    stats: {
      postsAnalyzed: xPosts.length,
      metricsCollected,
    },
  });

  // Log activity
  await db.insert(activityEvents).values({
    userId,
    eventType: 'x_metrics_collection',
    metadataJson: {
      postsAnalyzed: xPosts.length,
      metricsCollected,
    },
  });
}

export async function processXMetrics(job: Job<MetricsJobData>) {
  const log = loggerForJob(baseLog, job);
  if (isFanoutJob(job.data)) {
    const platform = (job.data as { platform?: string }).platform ?? 'x';
    // Cron fan-out: enqueue per-user metrics jobs.
    const xChannels = await db
      .select({ userId: channels.userId })
      .from(channels)
      .where(eq(channels.platform, platform));

    const userIds = [...new Set(xChannels.map((c) => c.userId))];
    log.info(
      `Cron fan-out: enqueueing ${userIds.length} per-user metrics jobs (${platform})`,
    );

    for (const uid of userIds) {
      await enqueueMetrics({ userId: uid, platform });
    }
    return;
  }

  const data = job.data as Extract<MetricsJobData, { userId: string }>;
  await processXMetricsForUser(data.userId, log);
}
