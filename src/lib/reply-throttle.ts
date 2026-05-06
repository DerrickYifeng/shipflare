/**
 * Author-level reply throttle predicate.
 *
 * Single source of truth used by `find_threads` (discovery filter) and
 * `draft_reply` (last-mile guard) so both code paths apply the same rule.
 *
 * Rule: returns true when there exists a draft (status pending / approved /
 * posted / handed_off) for `userId` on `platform` against a thread whose
 * `author` matches, created within `withinDays`. Drafts in terminal
 * non-engaging states (skipped / failed / flagged / needs_revision) do
 * NOT count — those represent rejection signals, not engagement, so the
 * author hasn't been bothered.
 *
 * Implementation uses two narrow queries (threads → drafts) instead of an
 * SQL join. The Postgres planner collapses the round-trip into the same
 * index hits the join would have produced; the in-memory DB used for
 * unit tests doesn't merge rows across `innerJoin`, so two queries are
 * both correct in production AND testable.
 */
import { and, eq, gte, inArray } from 'drizzle-orm';
import { drafts, threads } from '@/lib/db/schema';
import type { db as Db } from '@/lib/db';

export type ThrottleAwareDb = typeof Db;

export interface HasRecentReplyToAuthorInput {
  userId: string;
  platform: string;
  author: string | null;
  withinDays: number;
}

const BLOCKING_STATUSES: ReadonlyArray<
  'pending' | 'approved' | 'posted' | 'handed_off'
> = ['pending', 'approved', 'posted', 'handed_off'];

export async function hasRecentReplyToAuthor(
  db: ThrottleAwareDb,
  input: HasRecentReplyToAuthorInput,
): Promise<boolean> {
  if (!input.author) return false;
  if (input.withinDays <= 0) return false;

  const cutoff = new Date(Date.now() - input.withinDays * 86_400_000);

  const matchingThreads = await db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.userId, input.userId),
        eq(threads.platform, input.platform),
        eq(threads.author, input.author),
      ),
    );

  if (matchingThreads.length === 0) return false;

  const threadIds = matchingThreads.map((t) => t.id);

  const rows = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.userId, input.userId),
        inArray(drafts.threadId, threadIds),
        gte(drafts.createdAt, cutoff),
        inArray(drafts.status, BLOCKING_STATUSES),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * Listing variant — returns DISTINCT authors `userId` has engaged with on
 * `platform` in the last `withinDays`. Used by `find_threads_via_xai` to
 * tell Grok "don't surface tweets from these handles" upstream of the
 * search, so we don't waste search-API tokens on candidates we'll throw
 * away later in `judging-thread-quality` / the throttle.
 *
 * Capped at `limit` most-recent authors so the prompt stays bounded;
 * callers should tell xAI "and skip authors that look like our prior
 * reply targets" as a fallback for the long tail.
 */
export interface ListRecentEngagedAuthorsInput {
  userId: string;
  platform: string;
  withinDays: number;
  limit: number;
}

export async function listRecentEngagedAuthors(
  db: ThrottleAwareDb,
  input: ListRecentEngagedAuthorsInput,
): Promise<string[]> {
  if (input.withinDays <= 0 || input.limit <= 0) return [];

  const cutoff = new Date(Date.now() - input.withinDays * 86_400_000);

  const recentDrafts = await db
    .select({ threadId: drafts.threadId })
    .from(drafts)
    .where(
      and(
        eq(drafts.userId, input.userId),
        gte(drafts.createdAt, cutoff),
        inArray(drafts.status, BLOCKING_STATUSES),
      ),
    );

  if (recentDrafts.length === 0) return [];

  const threadIds = Array.from(new Set(recentDrafts.map((d) => d.threadId)));

  const matchingThreads = await db
    .select({ author: threads.author })
    .from(threads)
    .where(
      and(
        eq(threads.userId, input.userId),
        eq(threads.platform, input.platform),
        inArray(threads.id, threadIds),
      ),
    );

  const distinct: string[] = [];
  const seen = new Set<string>();
  for (const row of matchingThreads) {
    const author = row.author;
    if (typeof author !== 'string' || author.length === 0) continue;
    if (seen.has(author)) continue;
    seen.add(author);
    distinct.push(author);
    if (distinct.length >= input.limit) break;
  }

  return distinct;
}
