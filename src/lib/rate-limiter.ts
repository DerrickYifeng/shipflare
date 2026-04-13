import { db } from '@/lib/db';
import { posts } from '@/lib/db/schema';
import { eq, and, gte } from 'drizzle-orm';

const MAX_POSTS_PER_SUBREDDIT_PER_DAY = 3;

/**
 * Check if a user can post to a subreddit.
 * Limits: max 3 posts per day per subreddit.
 */
export async function canPostToSubreddit(
  userId: string,
  subreddit: string,
): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const recentPosts = await db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.userId, userId),
        eq(posts.community, subreddit),
        gte(posts.postedAt, dayAgo),
      ),
    );

  const count = recentPosts.length;
  const remaining = Math.max(0, MAX_POSTS_PER_SUBREDDIT_PER_DAY - count);
  const oldest = recentPosts[0]?.postedAt;
  const resetAt = oldest
    ? new Date(oldest.getTime() + 24 * 60 * 60 * 1000)
    : new Date();

  return {
    allowed: count < MAX_POSTS_PER_SUBREDDIT_PER_DAY,
    remaining,
    resetAt,
  };
}
