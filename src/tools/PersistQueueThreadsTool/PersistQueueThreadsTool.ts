import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import { db } from '@/lib/db';
import { threads } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';
import { tweetCandidateSchema, type TweetCandidate } from '@/tools/XaiFindCustomersTool/schema';
import { createLogger } from '@/lib/logger';

const log = createLogger('tool:persist_queue_threads');

export const PERSIST_QUEUE_THREADS_TOOL_NAME = 'persist_queue_threads';

const inputSchema = z.object({
  threads: z.array(tweetCandidateSchema).min(0).max(50),
});

export interface PersistQueueThreadsResult {
  inserted: number;
  deduped: number;
}

/**
 * Engagement-weighted score: scout-style confidence × log10 of weighted
 * engagement. Reposts count 5× a like (a public endorsement is meaningfully
 * stronger signal than a passive like). +1 inside the log avoids log10(0)
 * for zero-engagement tweets.
 */
function engagementScore(t: TweetCandidate): number {
  const likes = t.likes_count ?? 0;
  const reposts = t.reposts_count ?? 0;
  return t.confidence * Math.log10(1 + likes + 5 * reposts);
}

export const persistQueueThreadsTool = buildTool({
  name: PERSIST_QUEUE_THREADS_TOOL_NAME,
  description:
    'Persist a list of queue-worthy X tweets into the threads table for ' +
    '`/today` review. Computes engagement-weighted score and inserts in ' +
    'desc order so the highest-leverage threads appear first. ' +
    'INSERT ON CONFLICT DO NOTHING dedups by (user_id, platform, ' +
    'external_id); when a repost row already exists, the tool merges its ' +
    "new reposter handles into the existing row's surfaced_via JSONB.",
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
      { count: input.threads.length },
    );

    const sorted = [...input.threads].sort(
      (a, b) => engagementScore(b) - engagementScore(a),
    );

    const rows = sorted.map((t) => ({
      userId,
      externalId: t.external_id,
      platform: 'x' as const,
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
      state: 'queued' as const,
      // New columns from migration 0010:
      likesCount: t.likes_count,
      repostsCount: t.reposts_count,
      repliesCount: t.replies_count,
      viewsCount: t.views_count,
      isRepost: t.is_repost,
      originalUrl: t.original_url,
      originalAuthorUsername: t.original_author_username,
      surfacedVia: t.surfaced_via ?? null,
    }));

    const insertedRows = await db
      .insert(threads)
      .values(rows)
      .onConflictDoNothing({
        target: [threads.userId, threads.platform, threads.externalId],
      })
      .returning({ externalId: threads.externalId });

    const insertedIds = new Set(insertedRows.map((r) => r.externalId));
    const dedupedRows = sorted.filter((t) => !insertedIds.has(t.external_id));

    // For dedup'd repost rows that carry new reposter handles, merge into
    // the existing row's surfaced_via. JSONB array concat with dedup.
    for (const t of dedupedRows) {
      if (!t.is_repost || !t.surfaced_via || t.surfaced_via.length === 0) continue;
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
              eq(threads.platform, 'x'),
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
      `persist_queue_threads user=${userId}: inserted=${insertedRows.length} deduped=${
        rows.length - insertedRows.length
      }`,
    );

    return {
      inserted: insertedRows.length,
      deduped: rows.length - insertedRows.length,
    };
  },
});
