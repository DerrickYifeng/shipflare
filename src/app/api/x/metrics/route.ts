import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { xTweetMetrics, xFollowerSnapshots } from '@/lib/db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';

/**
 * GET /api/x/metrics
 * Returns tweet performance data and follower growth.
 * Query params: range=7d|30d|90d, sort=impressions|likes|bookmarks
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const range = searchParams.get('range') ?? '7d';
  const sort = searchParams.get('sort') ?? 'impressions';

  const days = range === '90d' ? 90 : range === '30d' ? 30 : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Fetch tweet metrics
  const metrics = await db
    .select()
    .from(xTweetMetrics)
    .where(
      and(
        eq(xTweetMetrics.userId, session.user.id),
        gte(xTweetMetrics.sampledAt, since),
      ),
    )
    .orderBy(desc(xTweetMetrics.sampledAt))
    .limit(500);

  // Dedupe by tweetId — keep latest sample for each tweet
  const latestByTweet = new Map<
    string,
    typeof metrics[number]
  >();
  for (const m of metrics) {
    const existing = latestByTweet.get(m.tweetId);
    if (!existing || m.sampledAt > existing.sampledAt) {
      latestByTweet.set(m.tweetId, m);
    }
  }

  let topTweets = Array.from(latestByTweet.values());

  // Sort
  if (sort === 'likes') {
    topTweets.sort((a, b) => b.likes - a.likes);
  } else if (sort === 'bookmarks') {
    topTweets.sort((a, b) => b.bookmarks - a.bookmarks);
  } else {
    topTweets.sort((a, b) => b.impressions - a.impressions);
  }

  topTweets = topTweets.slice(0, 20);

  // Fetch follower snapshots
  const followerHistory = await db
    .select()
    .from(xFollowerSnapshots)
    .where(
      and(
        eq(xFollowerSnapshots.userId, session.user.id),
        gte(xFollowerSnapshots.snapshotAt, since),
      ),
    )
    .orderBy(xFollowerSnapshots.snapshotAt)
    .limit(200);

  // Aggregate totals
  const totals = topTweets.reduce(
    (acc, m) => ({
      impressions: acc.impressions + m.impressions,
      likes: acc.likes + m.likes,
      retweets: acc.retweets + m.retweets,
      replies: acc.replies + m.replies,
      bookmarks: acc.bookmarks + m.bookmarks,
    }),
    { impressions: 0, likes: 0, retweets: 0, replies: 0, bookmarks: 0 },
  );

  // Follower growth
  const followerGrowth =
    followerHistory.length >= 2
      ? followerHistory[followerHistory.length - 1].followerCount -
        followerHistory[0].followerCount
      : 0;

  return NextResponse.json({
    range,
    totals,
    followerGrowth,
    followerHistory: followerHistory.map((s) => ({
      followerCount: s.followerCount,
      followingCount: s.followingCount,
      tweetCount: s.tweetCount,
      snapshotAt: s.snapshotAt,
    })),
    topTweets: topTweets.map((m) => ({
      tweetId: m.tweetId,
      impressions: m.impressions,
      likes: m.likes,
      retweets: m.retweets,
      replies: m.replies,
      bookmarks: m.bookmarks,
      quoteTweets: m.quoteTweets,
      sampledAt: m.sampledAt,
    })),
  });
}
