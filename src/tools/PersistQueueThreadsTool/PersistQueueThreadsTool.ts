import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import { db } from '@/lib/db';
import { threads } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';
import {
  tweetCandidateSchema,
  type TweetCandidate,
} from '@/tools/XaiFindCustomersTool/schema';
import {
  redditThreadCandidateSchema,
  type RedditThreadCandidate,
} from '@/tools/FindThreadsViaXaiTool/schemas';
import { PLATFORMS } from '@/lib/platform-config';
import { createLogger } from '@/lib/logger';

const log = createLogger('tool:persist_queue_threads');

export const PERSIST_QUEUE_THREADS_TOOL_NAME = 'persist_queue_threads';

/**
 * Discriminated union — the input schema is one of:
 *   { platform: 'x', threads: TweetCandidate[] }
 *   { platform: 'reddit', threads: RedditThreadCandidate[] }
 *
 * Using `z.discriminatedUnion` lets Zod statically narrow the threads
 * array to the matching candidate type once `platform` is known. This
 * keeps the row-builder type-safe at compile time and rejects mixed
 * platform inputs at the boundary.
 *
 * `platform` defaults to `'x'` is NOT possible inside a discriminated
 * union (Zod requires an explicit literal on every branch), so callers
 * MUST pass `platform`. The migration: every existing call site in
 * src/ already passes `platform` since Task 2b added the field.
 */
const xInputSchema = z.object({
  platform: z.literal(PLATFORMS.x.id as 'x'),
  threads: z.array(tweetCandidateSchema).min(0).max(50),
});

const redditInputSchema = z.object({
  platform: z.literal(PLATFORMS.reddit.id as 'reddit'),
  threads: z.array(redditThreadCandidateSchema).min(0).max(50),
});

const inputSchema = z.discriminatedUnion('platform', [
  xInputSchema,
  redditInputSchema,
]);

export interface PersistQueueThreadsResult {
  inserted: number;
  deduped: number;
}

/**
 * Engagement-weighted score for X tweets: scout-style confidence × log10
 * of weighted engagement. Reposts count 5× a like (a public endorsement
 * is meaningfully stronger signal than a passive like). +1 inside the
 * log avoids log10(0) for zero-engagement tweets.
 */
function engagementScoreX(t: TweetCandidate): number {
  const likes = t.likes_count ?? 0;
  const reposts = t.reposts_count ?? 0;
  return t.confidence * Math.log10(1 + likes + 5 * reposts);
}

/**
 * Engagement-weighted score for Reddit threads — mirrors the X formula
 * but uses upvotes (`score`) and `num_comments` (a Reddit comment is a
 * meaningfully stronger participation signal than a passive upvote).
 */
function engagementScoreReddit(t: RedditThreadCandidate): number {
  return t.confidence * Math.log10(1 + t.score + 5 * t.num_comments);
}

/** Build a threads-table row from one X tweet candidate. */
function mapXCandidate(
  t: TweetCandidate,
  userId: string,
): typeof threads.$inferInsert {
  return {
    userId,
    externalId: t.external_id,
    platform: PLATFORMS.x.id,
    community: 'x',
    title: '',
    url: t.url,
    body: t.body,
    author: t.author_username,
    upvotes: t.likes_count ?? null,
    commentCount: t.replies_count ?? null,
    scoutConfidence: t.confidence,
    scoutReason: t.reason,
    postedAt: t.posted_at ? new Date(t.posted_at) : null,
    state: 'queued',
    likesCount: t.likes_count,
    repostsCount: t.reposts_count,
    repliesCount: t.replies_count,
    viewsCount: t.views_count,
    isRepost: t.is_repost,
    originalUrl: t.original_url,
    originalAuthorUsername: t.original_author_username,
    surfacedVia: t.surfaced_via ?? null,
    canMentionProduct: t.can_mention_product ?? false,
    mentionSignal: t.mention_signal ?? 'no_fit',
    authorBio: t.author_bio ?? null,
    authorFollowers: t.author_followers ?? null,
    quotedText: t.quoted_text ?? null,
    quotedAuthor: t.quoted_author ?? null,
    inReplyToText: t.in_reply_to_text ?? null,
    inReplyToAuthor: t.in_reply_to_author ?? null,
  };
}

/**
 * Build a threads-table row from one Reddit thread candidate. Reddit
 * has no analog for likes_count/views_count/quoted_text/in_reply_to_*,
 * so those columns are NULL. `community` carries the subreddit name
 * (without the `r/` prefix). `upvotes` mirrors `score`. `commentCount`
 * AND `repliesCount` both mirror `num_comments` — `commentCount` is
 * the legacy/shared column the UI surfaces as a generic "engagement"
 * number; `repliesCount` is the X-shaped column we keep populated for
 * cross-platform reporting.
 */
function mapRedditCandidate(
  t: RedditThreadCandidate,
  userId: string,
): typeof threads.$inferInsert {
  return {
    userId,
    externalId: t.external_id,
    platform: PLATFORMS.reddit.id,
    community: t.subreddit,
    title: t.title,
    url: t.url,
    body: t.body,
    author: t.author_username,
    upvotes: t.score,
    commentCount: t.num_comments,
    scoutConfidence: t.confidence,
    scoutReason: t.reason,
    postedAt: t.posted_at ? new Date(t.posted_at) : null,
    state: 'queued',
    // Engagement columns: Reddit surfaces score (= upvotes), num_comments,
    // num_crossposts. Map score → upvotes (legacy) AND likesCount (X
    // semantic equivalence so cross-platform UI logic can read one
    // column). num_crossposts → repostsCount. num_comments →
    // repliesCount. viewsCount unavailable on Reddit's web_search.
    likesCount: null,
    repostsCount: t.num_crossposts,
    repliesCount: t.num_comments,
    viewsCount: null,
    isRepost: false,
    originalUrl: null,
    originalAuthorUsername: null,
    surfacedVia: null,
    isLocked: t.locked,
    isArchived: t.archived,
    // Mention-fit signals from judging-thread-quality run upstream;
    // the FindThreadsViaXaiTool merges them into the X candidate before
    // calling persist. Reddit's persist call does the same merge —
    // the Reddit candidate row gets `can_mention_product` /
    // `mention_signal` injected by the caller via spread, but the
    // RedditThreadCandidate Zod schema doesn't carry those fields, so
    // we read them off the row defensively (cast through Record so the
    // optional access doesn't trip strict checks).
    canMentionProduct:
      (t as RedditThreadCandidate & { can_mention_product?: boolean })
        .can_mention_product ?? false,
    mentionSignal:
      (t as RedditThreadCandidate & { mention_signal?: string })
        .mention_signal ?? 'no_fit',
    authorBio: null,
    authorFollowers: t.author_karma,
    quotedText: null,
    quotedAuthor: null,
    inReplyToText: null,
    inReplyToAuthor: null,
  };
}

export const persistQueueThreadsTool = buildTool({
  name: PERSIST_QUEUE_THREADS_TOOL_NAME,
  description:
    'Persist a list of queue-worthy threads (X tweets or Reddit posts) ' +
    'into the threads table for `/today` review. Computes ' +
    'engagement-weighted score and inserts in desc order so the ' +
    'highest-leverage threads appear first. INSERT ON CONFLICT DO ' +
    'NOTHING dedups by (user_id, platform, external_id); when an X ' +
    "repost row already exists, the tool merges its new reposter " +
    "handles into the existing row's surfaced_via JSONB.\n\n" +
    'INPUT SHAPE (`platform` discriminates the `threads` array shape):\n\n' +
    'X path:\n' +
    '{\n' +
    '  "platform": "x",\n' +
    '  "threads": [\n' +
    '    {\n' +
    '      "external_id": "1234567890",\n' +
    '      "url": "https://twitter.com/user/status/1234567890",\n' +
    '      "author_username": "indie_founder",\n' +
    '      "body": "Struggling to find a CI tool ...",\n' +
    '      "likes_count": 42,\n' +
    '      "reposts_count": 5,\n' +
    '      "confidence": 0.82,\n' +
    '      "reason": "Pain match"\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    'Reddit path:\n' +
    '{\n' +
    '  "platform": "reddit",\n' +
    '  "threads": [\n' +
    '    {\n' +
    '      "external_id": "1abc234",\n' +
    '      "url": "https://www.reddit.com/r/SaaS/comments/1abc234/title",\n' +
    '      "subreddit": "SaaS",\n' +
    '      "author_username": "indie_founder",\n' +
    '      "title": "How do I market my SaaS",\n' +
    '      "body": "...",\n' +
    '      "score": 42,\n' +
    '      "num_comments": 17,\n' +
    '      "num_crossposts": 0,\n' +
    '      "confidence": 0.82,\n' +
    '      "reason": "Pain match"\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    'Pass an empty array `[]` when no qualifying threads were found ' +
    '(returns { inserted: 0, deduped: 0 }).',
  inputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input, ctx): Promise<PersistQueueThreadsResult> {
    const { userId } = readDomainDeps(ctx);

    if (input.threads.length === 0) {
      return { inserted: 0, deduped: 0 };
    }

    ctx.emitProgress?.(
      'persist_queue_threads',
      `Persisting ${input.threads.length} thread${input.threads.length === 1 ? '' : 's'}…`,
      { count: input.threads.length, platform: input.platform },
    );

    if (input.platform === 'x') {
      return persistX(input.threads, userId);
    }
    return persistReddit(input.threads, userId);
  },
});

/**
 * X persist branch — sort by X engagement score, insert, then merge
 * surfaced_via for any deduplicated repost rows that carry new
 * reposter handles. Repost merging is X-specific (Reddit's web_search
 * doesn't have an analogous "this thread surfaced via N reposters"
 * pathway), so the surfaced_via merge lives only here.
 */
async function persistX(
  candidates: TweetCandidate[],
  userId: string,
): Promise<PersistQueueThreadsResult> {
  const sorted = [...candidates].sort(
    (a, b) => engagementScoreX(b) - engagementScoreX(a),
  );
  const rows = sorted.map((t) => mapXCandidate(t, userId));

  const insertedRows = await db
    .insert(threads)
    .values(rows)
    .onConflictDoNothing({
      target: [threads.userId, threads.platform, threads.externalId],
    })
    .returning({ externalId: threads.externalId });

  const insertedIds = new Set(insertedRows.map((r) => r.externalId));
  const dedupedRows = sorted.filter((t) => !insertedIds.has(t.external_id));
  for (const t of dedupedRows) {
    if (!t.is_repost || !t.surfaced_via || t.surfaced_via.length === 0) {
      continue;
    }
    try {
      await db
        .update(threads)
        .set({
          surfacedVia: sql`(
            SELECT jsonb_agg(DISTINCT v)
            FROM jsonb_array_elements_text(
              COALESCE(${threads.surfacedVia}, '[]'::jsonb) || ${JSON.stringify(t.surfaced_via)}::jsonb
            ) AS v
          )`,
        })
        .where(
          and(
            eq(threads.userId, userId),
            eq(threads.platform, PLATFORMS.x.id),
            eq(threads.externalId, t.external_id),
          ),
        );
    } catch (err) {
      log.warn(
        `surfaced_via merge failed for ${t.external_id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  log.info(
    `persist_queue_threads user=${userId} platform=x: ` +
      `inserted=${insertedRows.length} deduped=${
        rows.length - insertedRows.length
      }`,
  );

  return {
    inserted: insertedRows.length,
    deduped: rows.length - insertedRows.length,
  };
}

/**
 * Reddit persist branch — sort by Reddit engagement score, insert with
 * conflict-do-nothing dedup. No surfaced_via merge (Reddit doesn't
 * surface that signal). Mention-fit fields are read off the row by
 * `mapRedditCandidate` defensively (the schema doesn't carry them).
 */
async function persistReddit(
  candidates: RedditThreadCandidate[],
  userId: string,
): Promise<PersistQueueThreadsResult> {
  const sorted = [...candidates].sort(
    (a, b) => engagementScoreReddit(b) - engagementScoreReddit(a),
  );
  const rows = sorted.map((t) => mapRedditCandidate(t, userId));

  const insertedRows = await db
    .insert(threads)
    .values(rows)
    .onConflictDoNothing({
      target: [threads.userId, threads.platform, threads.externalId],
    })
    .returning({ externalId: threads.externalId });

  log.info(
    `persist_queue_threads user=${userId} platform=reddit: ` +
      `inserted=${insertedRows.length} deduped=${
        rows.length - insertedRows.length
      }`,
  );

  return {
    inserted: insertedRows.length,
    deduped: rows.length - insertedRows.length,
  };
}
