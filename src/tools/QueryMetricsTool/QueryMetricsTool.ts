// query_metrics — aggregated posting / reply / discovery metrics for the
// current user, across a range window.
//
// Phase B basic impl: counts from `posts`, `drafts`, and `threads`. The
// `posts` table is productless (userId only) — we scope by userId since
// every user has one product today (`products_user_uq`). Phase E will
// layer in `analyticsSummary` integration + per-post engagement.

import { z } from 'zod';
import { and, desc, eq, gte } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { posts, drafts, threads } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';

export const QUERY_METRICS_TOOL_NAME = 'query_metrics';

export const queryMetricsInputSchema = z
  .object({
    range: z.enum(['last_week', 'last_month', 'all']),
  })
  .strict();

export type QueryMetricsInput = z.infer<typeof queryMetricsInputSchema>;

export interface MetricsResult {
  range: 'last_week' | 'last_month' | 'all';
  postsPublished: number;
  repliesSent: number;
  threadsDiscovered: number;
  /**
   * Top posts by upvotes (when we have the signal). Empty until Phase E
   * wires in engagement scoring across both reddit + x posts.
   */
  topPosts?: Array<{
    id: string;
    platform: string;
    community: string;
    postedAt: string;
  }>;
}

function cutoffFor(range: QueryMetricsInput['range']): Date | null {
  const now = Date.now();
  if (range === 'last_week') {
    return new Date(now - 7 * 24 * 60 * 60 * 1000);
  }
  if (range === 'last_month') {
    return new Date(now - 30 * 24 * 60 * 60 * 1000);
  }
  return null;
}

export const queryMetricsTool: ToolDefinition<
  QueryMetricsInput,
  MetricsResult
> = buildTool({
  name: QUERY_METRICS_TOOL_NAME,
  description:
    'Return aggregate posting metrics for the current user over a range ' +
    '(last_week | last_month | all): posts published, replies sent, and ' +
    'threads discovered. Use this to spot trends before re-planning.',
  inputSchema: queryMetricsInputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input, ctx): Promise<MetricsResult> {
    const { db, userId } = readDomainDeps(ctx);
    const cutoff = cutoffFor(input.range);

    const postsWhere = cutoff
      ? and(eq(posts.userId, userId), gte(posts.postedAt, cutoff))
      : eq(posts.userId, userId);
    const postsRows = await db
      .select({
        id: posts.id,
        platform: posts.platform,
        community: posts.community,
        postedAt: posts.postedAt,
        draftType: drafts.draftType,
      })
      .from(posts)
      .innerJoin(drafts, eq(drafts.id, posts.draftId))
      .where(postsWhere)
      .orderBy(desc(posts.postedAt))
      .limit(1000);

    // Split into replies vs original posts using draft.draftType — 'reply'
    // is the reply case, 'original_post' is the post case. drafts.draftType
    // defaults to 'reply' so legacy rows still count as replies.
    let postsPublished = 0;
    let repliesSent = 0;
    for (const row of postsRows) {
      if (row.draftType === 'original_post') postsPublished += 1;
      else repliesSent += 1;
    }

    const threadsWhere = cutoff
      ? and(eq(threads.userId, userId), gte(threads.discoveredAt, cutoff))
      : eq(threads.userId, userId);
    const threadsRows = await db
      .select({ id: threads.id })
      .from(threads)
      .where(threadsWhere)
      .limit(10_000);

    // TODO(Phase E): replace this crude "top posts = most recent" proxy
    // with an actual engagement join once analyticsSummary / xTweetMetrics
    // are wired in for both platforms.
    const topPosts = postsRows.slice(0, 5).map((p) => ({
      id: p.id,
      platform: p.platform,
      community: p.community,
      postedAt:
        p.postedAt instanceof Date ? p.postedAt.toISOString() : String(p.postedAt),
    }));

    return {
      range: input.range,
      postsPublished,
      repliesSent,
      threadsDiscovered: threadsRows.length,
      topPosts,
    };
  },
});
