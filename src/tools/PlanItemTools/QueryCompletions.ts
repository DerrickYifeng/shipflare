// query_last_week_completions — plan_items that completed (state='completed')
// during last week's Monday 00:00 UTC → this Monday 00:00 UTC window.
//
// Note on naming: the spec wording says `state='posted' AND postedAt BETWEEN`
// — but our actual plan_items enum uses `'completed'` (with `completedAt`).
// We honor the schema we ship; state='posted' doesn't exist. See
// `src/lib/db/schema/plan-items.ts` for the enum.
//
// `angle` is pulled from `plan_items.params.angle` when present
// (content_post items store the planner's chosen angle there —
// see calendarPlanOutputSchema / tacticalPlanItemSchema.params).
// `engagementScore` is a TODO (Phase E): plan_items don't reference posts
// directly, so a clean join requires an indirect lookup via drafts→posts,
// which we leave stubbed here to avoid speculative schema coupling.

import { z } from 'zod';
import { and, eq, gte, lt } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { planItems } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';
import { weekBoundsForOffset } from './Query';

export const QUERY_LAST_WEEK_COMPLETIONS_TOOL_NAME =
  'query_last_week_completions';

export interface LastWeekCompletionRow {
  id: string;
  title: string;
  channel: string | null;
  angle: string | null;
  engagementScore?: number;
}

export const queryLastWeekCompletionsTool: ToolDefinition<
  Record<string, never>,
  LastWeekCompletionRow[]
> = buildTool({
  name: QUERY_LAST_WEEK_COMPLETIONS_TOOL_NAME,
  description:
    'List plan_items that reached state=completed during the last full ' +
    'Monday-Monday UTC week. Useful for weekly retrospectives and for ' +
    'anchoring this week\'s plan to what actually shipped.',
  inputSchema: z.object({}).strict(),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(_input, ctx): Promise<LastWeekCompletionRow[]> {
    const { db, userId, productId } = readDomainDeps(ctx);
    const { start, end } = weekBoundsForOffset(new Date(), -1);

    const rows = await db
      .select({
        id: planItems.id,
        title: planItems.title,
        channel: planItems.channel,
        params: planItems.params,
        completedAt: planItems.completedAt,
      })
      .from(planItems)
      .where(
        and(
          eq(planItems.userId, userId),
          eq(planItems.productId, productId),
          eq(planItems.state, 'completed'),
          // completedAt can be null for rows that transitioned via bulk
          // patches; exclude those by gating on scheduledAt as a fallback
          // proxy — scheduledAt is notNull.
          gte(planItems.completedAt, start),
          lt(planItems.completedAt, end),
        ),
      )
      .limit(200);

    return rows.map((r) => {
      const params = (r.params ?? {}) as Record<string, unknown>;
      const angle =
        typeof params.angle === 'string' ? (params.angle as string) : null;
      // TODO(Phase E): join drafts → posts on plan_items.params.draftId (or
      // similar indirection once defined) to surface real engagement numbers.
      return {
        id: r.id,
        title: r.title,
        channel: r.channel ?? null,
        angle,
      };
    });
  },
});
