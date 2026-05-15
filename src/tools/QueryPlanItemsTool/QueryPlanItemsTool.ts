// query_plan_items — generic filter on plan_items, scoped to the
// caller's (userId, productId).
//
// `weekOffset`: 0 = current week, 1 = next week, -1 = last week. Weeks are
// Monday 00:00 UTC → next Monday 00:00 UTC.
// `status`: array of state values to include. Default: any.
// `id`: when present, returns only that row (still ownership-scoped).
// `limit`: cap the result size. Default 50, hard max 200.

import { z } from 'zod';
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { drafts, planItems, planItemStateEnum } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';

export const QUERY_PLAN_ITEMS_TOOL_NAME = 'query_plan_items';

const planItemStateValues = planItemStateEnum.enumValues as unknown as [
  string,
  ...string[],
];

export const queryPlanItemsInputSchema = z
  .object({
    weekOffset: z.number().int().min(-52).max(52).nullish(),
    status: z.array(z.enum(planItemStateValues)).max(10).nullish(),
    id: z.string().min(1).nullish(),
    limit: z.number().int().min(1).max(200).nullish(),
  })
  .strict();

export type QueryPlanItemsInput = z.infer<typeof queryPlanItemsInputSchema>;

export interface QueryPlanItemsRow {
  id: string;
  kind: string;
  state: string;
  userAction: string;
  phase: string;
  channel: string | null;
  dueDate: string; // YYYY-MM-DD
  sortOrder: number;
  skillName: string | null;
  params: unknown;
  title: string;
  description: string | null;
  completedAt: string | null;
  /**
   * Count of `drafts` rows whose `planItemId` equals this row's id and
   * whose `status` is `pending` (i.e. live, not yet rejected/posted).
   * Lets the coordinator mechanically verify a specialist's claim
   * before flipping `state` to `drafted`: if a specialist returned
   * `draftsCreated: 8` but `draftCount === 0`, the drafts landed under
   * the wrong slot. Indexed via `drafts_plan_item_idx` so the LEFT
   * JOIN scan stays cheap.
   */
  draftCount: number;
}

/**
 * Compute the UTC Monday-00:00 bounds for the week offset from today.
 * Shared with query_last_week_completions.
 */
export function weekBoundsForOffset(
  now: Date,
  weekOffset: number,
): { start: Date; end: Date } {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  const dayOffset = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dayOffset + weekOffset * 7);
  const start = new Date(d);
  const end = new Date(d);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
}

export const queryPlanItemsTool: ToolDefinition<
  QueryPlanItemsInput,
  QueryPlanItemsRow[]
> = buildTool({
  name: QUERY_PLAN_ITEMS_TOOL_NAME,
  description:
    'List plan_items for the current product. Filter by weekOffset ' +
    '(0=this week, 1=next, -1=last), by status (array of state values: ' +
    `${planItemStateValues.join(', ')}), or by a specific id. Omit ` +
    'filters to skip them. Scoped to the current user + product.' +
    '\n\n' +
    'Each row carries `draftCount`, semantics by kind:\n' +
    '  - content_reply: number of live `pending` drafts rows linked to ' +
    'this plan_item (one per thread; can exceed 1 for over-fetched slots).\n' +
    '  - content_post: 1 if `plan_items.output.draft_body` is non-empty, ' +
    'else 0 (posts persist the body inline; no `drafts` row).\n' +
    'Use it to verify a specialist actually drafted what it claimed ' +
    'before flipping state to `drafted` — a `draftsCreated: N` ' +
    'task_notification paired with `draftCount: 0` means the drafts ' +
    'landed under the wrong slot.' +
    '\n\n' +
    'INPUT SHAPE (`status` MUST be an array of strings, NOT a single string):\n' +
    '{ "weekOffset": 0, "status": ["planned", "drafted"], "limit": 20 }\n\n' +
    'To query a single state: `"status": ["planned"]` (still wrap it in an array).',
  inputSchema: queryPlanItemsInputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input, ctx): Promise<QueryPlanItemsRow[]> {
    const { db, userId, productId } = readDomainDeps(ctx);

    const limit = input.limit ?? 50;

    const conditions = [
      eq(planItems.userId, userId),
      eq(planItems.productId, productId),
    ];

    if (input.id != null) {
      conditions.push(eq(planItems.id, input.id));
    }

    if (input.weekOffset != null) {
      const { start, end } = weekBoundsForOffset(new Date(), input.weekOffset);
      conditions.push(gte(planItems.dueDate, start));
      conditions.push(lt(planItems.dueDate, end));
    }

    if (input.status != null && input.status.length > 0) {
      conditions.push(
        // Drizzle's inArray expects the same type; the enum column accepts
        // the string values at the SQL layer.
        inArray(planItems.state, input.status as never[]),
      );
    }

    const rows = await db
      .select({
        id: planItems.id,
        kind: planItems.kind,
        state: planItems.state,
        userAction: planItems.userAction,
        phase: planItems.phase,
        channel: planItems.channel,
        dueDate: planItems.dueDate,
        sortOrder: planItems.sortOrder,
        skillName: planItems.skillName,
        params: planItems.params,
        title: planItems.title,
        description: planItems.description,
        completedAt: planItems.completedAt,
        // Needed only for the content_post branch of draftCount —
        // posts persist their body inside `plan_items.output.draft_body`
        // (DraftPostTool.ts) instead of inserting a `drafts` row, so
        // counting `drafts` rows would always return 0 for posts.
        output: planItems.output,
      })
      .from(planItems)
      .where(and(...conditions))
      .limit(limit);

    // Build draftCount, branching on kind:
    //
    //  - content_reply: count `pending` drafts rows linked to this
    //    plan_item via drafts.planItemId. There can be many (one per
    //    thread) so a real count is meaningful; index
    //    `drafts_plan_item_idx` keeps the lookup cheap.
    //
    //  - content_post: there is no drafts row — DraftPostTool writes
    //    the body to plan_items.output.draft_body and flips state to
    //    'drafted' in a single UPDATE. So treat the body's presence as
    //    `1` and absence as `0`. Without this branch, the coordinator's
    //    Tier 2 verification flagged every drafted post as a phantom
    //    (state='drafted', draftCount=0) and warned the founder of a
    //    persistence failure that wasn't there.
    //
    // Kept as separate queries rather than SQL LEFT JOIN + GROUP BY so
    // the in-memory test mock (which doesn't implement leftJoin/
    // groupBy) keeps working, and so the predicate per branch is
    // obvious to the reader.
    const draftCountByPlanItemId = new Map<string, number>();
    const replyPlanItemIds = rows
      .filter((r) => r.kind === 'content_reply')
      .map((r) => r.id);
    if (replyPlanItemIds.length > 0) {
      const draftRows = await db
        .select({ planItemId: drafts.planItemId })
        .from(drafts)
        .where(
          and(
            eq(drafts.userId, userId),
            eq(drafts.status, 'pending'),
            inArray(drafts.planItemId, replyPlanItemIds),
          ),
        );
      for (const dr of draftRows) {
        if (dr.planItemId == null) continue;
        draftCountByPlanItemId.set(
          dr.planItemId,
          (draftCountByPlanItemId.get(dr.planItemId) ?? 0) + 1,
        );
      }
    }
    for (const r of rows) {
      if (r.kind !== 'content_post') continue;
      const body =
        r.output &&
        typeof r.output === 'object' &&
        !Array.isArray(r.output) &&
        typeof (r.output as Record<string, unknown>)['draft_body'] === 'string'
          ? ((r.output as Record<string, unknown>)['draft_body'] as string)
          : '';
      draftCountByPlanItemId.set(r.id, body.trim().length > 0 ? 1 : 0);
    }

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      state: r.state,
      userAction: r.userAction,
      phase: r.phase,
      channel: r.channel ?? null,
      dueDate:
        r.dueDate instanceof Date
          ? r.dueDate.toISOString().slice(0, 10)
          : String(r.dueDate),
      sortOrder: r.sortOrder,
      skillName: r.skillName ?? null,
      params: r.params ?? null,
      title: r.title,
      description: r.description ?? null,
      completedAt:
        r.completedAt instanceof Date
          ? r.completedAt.toISOString()
          : r.completedAt
            ? String(r.completedAt)
            : null,
      draftCount: draftCountByPlanItemId.get(r.id) ?? 0,
    }));
  },
});
