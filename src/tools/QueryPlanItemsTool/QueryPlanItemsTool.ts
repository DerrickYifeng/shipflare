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
import { planItems, planItemStateEnum } from '@/lib/db/schema';
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
  scheduledAt: string;
  skillName: string | null;
  params: unknown;
  title: string;
  description: string | null;
  completedAt: string | null;
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
      conditions.push(gte(planItems.scheduledAt, start));
      conditions.push(lt(planItems.scheduledAt, end));
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
        scheduledAt: planItems.scheduledAt,
        skillName: planItems.skillName,
        params: planItems.params,
        title: planItems.title,
        description: planItems.description,
        completedAt: planItems.completedAt,
      })
      .from(planItems)
      .where(and(...conditions))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      state: r.state,
      userAction: r.userAction,
      phase: r.phase,
      channel: r.channel ?? null,
      scheduledAt:
        r.scheduledAt instanceof Date
          ? r.scheduledAt.toISOString()
          : String(r.scheduledAt),
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
    }));
  },
});
