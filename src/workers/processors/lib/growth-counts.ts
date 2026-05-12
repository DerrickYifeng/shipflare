import { db } from '@/lib/db';
import { drafts, posts, threads } from '@/lib/db/schema';
import { and, eq, gte, sql, inArray, max } from 'drizzle-orm';

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function countThreads(
  userId: string,
  platform: string,
  weekAgo: Date,
): Promise<number> {
  // Threads that produced ≥1 draft for this user within the window.
  // (Spec open-question #1: under-count vs full discovery is acceptable.)
  // Uses `threads.discoveredAt` since the `threads` table tracks discovery
  // time, not row-creation time.
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${threads.id})::int` })
    .from(threads)
    .innerJoin(drafts, eq(drafts.threadId, threads.id))
    .where(
      and(
        eq(drafts.userId, userId),
        eq(threads.platform, platform),
        gte(threads.discoveredAt, weekAgo),
      ),
    );
  return row?.n ?? 0;
}

export async function countDrafts(
  userId: string,
  platform: string,
  weekAgo: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(
      and(
        eq(drafts.userId, userId),
        eq(threads.platform, platform),
        gte(drafts.createdAt, weekAgo),
      ),
    );
  return row?.n ?? 0;
}

export async function countPosts(
  userId: string,
  platform: string,
  weekAgo: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(posts)
    .innerJoin(drafts, eq(posts.draftId, drafts.id))
    .where(
      and(
        eq(posts.userId, userId),
        eq(posts.platform, platform),
        gte(posts.postedAt, weekAgo),
        inArray(posts.status, ['posted', 'verified']),
        eq(drafts.draftType, 'original_post'),
      ),
    );
  return row?.n ?? 0;
}

export async function countReplies(
  userId: string,
  platform: string,
  weekAgo: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(posts)
    .innerJoin(drafts, eq(posts.draftId, drafts.id))
    .where(
      and(
        eq(posts.userId, userId),
        eq(posts.platform, platform),
        gte(posts.postedAt, weekAgo),
        inArray(posts.status, ['posted', 'verified']),
        eq(drafts.draftType, 'reply'),
      ),
    );
  return row?.n ?? 0;
}

export async function countPending(
  userId: string,
  platform: string,
): Promise<number> {
  // Pending is point-in-time (no window).
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(
      and(
        eq(drafts.userId, userId),
        eq(threads.platform, platform),
        eq(drafts.status, 'pending'),
      ),
    );
  return row?.n ?? 0;
}

export async function countApprovedSkipped(
  userId: string,
  platform: string,
  weekAgo: Date,
): Promise<{ approved: number; skipped: number }> {
  const [row] = await db
    .select({
      approved: sql<number>`count(*) filter (where ${drafts.status} = 'approved')::int`,
      skipped: sql<number>`count(*) filter (where ${drafts.status} = 'skipped')::int`,
    })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(
      and(
        eq(drafts.userId, userId),
        eq(threads.platform, platform),
        gte(drafts.updatedAt, weekAgo),
      ),
    );
  return {
    approved: row?.approved ?? 0,
    skipped: row?.skipped ?? 0,
  };
}

export async function lastPostAt(
  userId: string,
  platform: string,
): Promise<Date | null> {
  // No window — we want the last-ever post.
  const [row] = await db
    .select({ t: max(posts.postedAt) })
    .from(posts)
    .where(and(eq(posts.userId, userId), eq(posts.platform, platform)));
  return row?.t ?? null;
}
