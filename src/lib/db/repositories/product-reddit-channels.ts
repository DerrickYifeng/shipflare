/**
 * Data-access helpers for product_reddit_channels.
 *
 * The kickoff coordinator reads `listActiveSubreddits` when constructing
 * the goal text (Task 6). Settings UI / API endpoints use the other
 * helpers for swap / disable / manual-add. The planner could call
 * `markSubredditUsed` per content_post bind (Task 6) — currently not
 * read anywhere but kept for symmetry and a future round-robin variant
 * that weights by recency.
 */
import { db } from '@/lib/db';
import { productRedditChannels } from '@/lib/db/schema';
import { and, eq, asc } from 'drizzle-orm';

export interface ActiveSubredditRow {
  subreddit: string;
  rank: number;
  fitScore: number | null;
}

/** Non-disabled rows for a product, ordered by rank (1, 2, 3, ...). */
export async function listActiveSubreddits(
  productId: string,
): Promise<ActiveSubredditRow[]> {
  return db
    .select({
      subreddit: productRedditChannels.subreddit,
      rank: productRedditChannels.rank,
      fitScore: productRedditChannels.fitScore,
    })
    .from(productRedditChannels)
    .where(
      and(
        eq(productRedditChannels.productId, productId),
        eq(productRedditChannels.disabled, false),
      ),
    )
    .orderBy(asc(productRedditChannels.rank));
}

/** All rows (active + disabled) — for settings UI display. */
export async function listAllSubreddits(productId: string) {
  return db
    .select()
    .from(productRedditChannels)
    .where(eq(productRedditChannels.productId, productId))
    .orderBy(asc(productRedditChannels.rank));
}

/** Mark a subreddit as just-used. Planner calls this per content_post
 *  bind. Currently informational; future weighted-rotation may read it. */
export async function markSubredditUsed(
  productId: string,
  subreddit: string,
): Promise<void> {
  await db
    .update(productRedditChannels)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(productRedditChannels.productId, productId),
        eq(productRedditChannels.subreddit, subreddit),
      ),
    );
}

/** Toggle the `disabled` flag. Settings UI uses this. */
export async function setSubredditDisabled(
  productId: string,
  subreddit: string,
  disabled: boolean,
): Promise<void> {
  await db
    .update(productRedditChannels)
    .set({ disabled, updatedAt: new Date() })
    .where(
      and(
        eq(productRedditChannels.productId, productId),
        eq(productRedditChannels.subreddit, subreddit),
      ),
    );
}

/** Insert a manual subreddit. Idempotent: re-adding the same name
 *  un-disables it instead of erroring on the UNIQUE constraint. */
export async function upsertManualSubreddit(args: {
  productId: string;
  userId: string;
  subreddit: string;
}): Promise<void> {
  const { productId, userId, subreddit } = args;
  await db
    .insert(productRedditChannels)
    .values({ productId, userId, subreddit, source: 'manual', rank: 99 })
    .onConflictDoUpdate({
      target: [productRedditChannels.productId, productRedditChannels.subreddit],
      set: { disabled: false, updatedAt: new Date() },
    });
}
