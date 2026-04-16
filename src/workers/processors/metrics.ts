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
import { publishEvent } from '@/lib/redis';
import type { MetricsJobData } from '@/lib/queue/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('worker:x-metrics');

const METRICS_LOOKBACK_DAYS = 7;
const BATCH_SIZE = 100;

async function processXMetricsForUser(userId: string) {
  log.info(`Collecting X metrics for user ${userId}`);

  // Load X channel — explicit projection for XClient.fromChannel
  const [xChannel] = await db
    .select({
      id: channels.id,
      oauthTokenEncrypted: channels.oauthTokenEncrypted,
      refreshTokenEncrypted: channels.refreshTokenEncrypted,
      tokenExpiresAt: channels.tokenExpiresAt,
    })
    .from(channels)
    .where(and(eq(channels.userId, userId), eq(channels.platform, 'x')))
    .limit(1);

  if (!xChannel) throw new Error('No X channel connected');

  const xClient = XClient.fromChannel(xChannel);

  // Snapshot follower count
  try {
    const me = await xClient.getMe();
    if (me.publicMetrics) {
      await db.insert(xFollowerSnapshots).values({
        userId,
        followerCount: me.publicMetrics.followersCount,
        followingCount: me.publicMetrics.followingCount,
        tweetCount: me.publicMetrics.tweetCount,
      });
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
        gte(posts.postedAt, lookbackDate),
      ),
    );

  // Filter to only X posts (those with numeric external IDs)
  const xPosts = recentPosts.filter(
    (p) => p.externalId && /^\d+$/.test(p.externalId),
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
  await publishEvent(`shipflare:events:${userId}`, {
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
  const { userId } = job.data;

  if (userId === '__all__') {
    // Cron fan-out: find all users with an active X channel and process each
    const xChannels = await db
      .select({ userId: channels.userId })
      .from(channels)
      .where(eq(channels.platform, 'x'));

    const userIds = [...new Set(xChannels.map((c) => c.userId))];
    log.info(`Cron fan-out: collecting metrics for ${userIds.length} users with X channels`);

    for (const uid of userIds) {
      try {
        await processXMetricsForUser(uid);
      } catch (err) {
        log.error(`X metrics failed for user ${uid}: ${err}`);
      }
    }
    return;
  }

  await processXMetricsForUser(userId);
}
