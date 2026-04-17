import { db } from '@/lib/db';
import { posts, xTweetMetrics, xFollowerSnapshots } from '@/lib/db/schema';
import { and, eq, gte, desc } from 'drizzle-orm';
import { XClient, XForbiddenError } from '@/lib/x-client';
import { createPlatformDeps } from '@/lib/platform-deps';
import { createLogger } from '@/lib/logger';
import type { MetricsCollector } from '@/lib/metrics-collector';

const log = createLogger('collector:x-metrics');

const METRICS_LOOKBACK_DAYS = 7;
const BATCH_SIZE = 100;

/**
 * X (Twitter) implementation of the platform-agnostic MetricsCollector
 * interface. Resolves the X channel via `createPlatformDeps`, which is the
 * sanctioned path for token-column access (see CLAUDE.md → Security TODO).
 * Pulls public_metrics for up to the last 7 days of posts in batches of 100
 * tweet IDs.
 *
 * On X API 403 (Basic tier required for public_metrics) we log a warning
 * and return a zero count instead of throwing — matches the inline
 * behaviour in workers/processors/metrics.ts so extracting the logic
 * doesn't change the runtime contract.
 */
export class XMetricsCollector implements MetricsCollector {
  async collectPostMetrics(
    userId: string,
  ): Promise<{ collected: number; analyzed: number }> {
    const deps = await createPlatformDeps('x', userId);
    const xClient = deps.xClient as XClient | undefined;

    if (!xClient) {
      log.warn(`No X channel for user ${userId}, skipping metrics`);
      return { collected: 0, analyzed: 0 };
    }

    const lookbackDate = new Date(
      Date.now() - METRICS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );

    const recentPosts = await db
      .select({
        id: posts.id,
        externalId: posts.externalId,
      })
      .from(posts)
      .where(
        and(
          eq(posts.userId, userId),
          eq(posts.platform, 'x'),
          gte(posts.postedAt, lookbackDate),
        ),
      );

    const xPosts = recentPosts.filter(
      (p): p is typeof p & { externalId: string } => p.externalId !== null,
    );

    if (xPosts.length === 0) {
      return { collected: 0, analyzed: 0 };
    }

    let collected = 0;
    try {
      for (let i = 0; i < xPosts.length; i += BATCH_SIZE) {
        const batch = xPosts.slice(i, i + BATCH_SIZE);
        const tweetIds = batch.map((p) => p.externalId);
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
          collected++;
        }
      }
    } catch (err) {
      if (err instanceof XForbiddenError) {
        log.warn(
          'X API 403 — Basic tier required for tweet metrics. Skipping.',
        );
        return { collected, analyzed: xPosts.length };
      }
      throw err;
    }

    return { collected, analyzed: xPosts.length };
  }

  async collectUserSnapshot(userId: string): Promise<void> {
    const deps = await createPlatformDeps('x', userId);
    const xClient = deps.xClient as XClient | undefined;

    if (!xClient) return;

    try {
      const me = await xClient.getMe();
      if (!me.publicMetrics) return;

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
    } catch (err) {
      log.warn(
        `Failed to snapshot follower count for ${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Convenience: latest X metrics for a user, useful for the dashboard
   * "recent post performance" view. Not part of the MetricsCollector
   * interface (each platform has different metric shapes).
   */
  async getRecentMetrics(userId: string, limit = 10) {
    return db
      .select({
        tweetId: xTweetMetrics.tweetId,
        impressions: xTweetMetrics.impressions,
        likes: xTweetMetrics.likes,
        replies: xTweetMetrics.replies,
        bookmarks: xTweetMetrics.bookmarks,
        sampledAt: xTweetMetrics.sampledAt,
      })
      .from(xTweetMetrics)
      .where(eq(xTweetMetrics.userId, userId))
      .orderBy(desc(xTweetMetrics.sampledAt))
      .limit(limit);
  }
}
