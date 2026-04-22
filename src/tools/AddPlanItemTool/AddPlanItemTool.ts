// add_plan_item — INSERT a single plan_items row.
//
// Called by: coordinator, content-planner. Used in parallel when a planner
// emits a week of items (isConcurrencySafe=true — multiple adds don't
// interfere).
//
// Plan-items live under a `plans` row (FK planId NOT NULL). The caller's
// ToolContext may provide `planId` directly; otherwise we pick the latest
// plan for (userId, productId) — which is the content-planner's active
// week. If none exists, we surface a diagnostic rather than silently
// creating a `plans` row — plan creation is the coordinator's call via
// the /api/team/run entry route, not a side-effect of adding an item.

import { and, desc, eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { planItems, plans } from '@/lib/db/schema';
import { planItemInputSchema, type PlanItemInput } from '@/tools/schemas';
import { readDomainDeps, tryGet } from '@/tools/context-helpers';

export const ADD_PLAN_ITEM_TOOL_NAME = 'add_plan_item';

export interface AddPlanItemResult {
  planItemId: string;
  planId: string;
}

/** Resolve the planId to attach this item to. */
async function resolvePlanId(
  ctx: Parameters<typeof readDomainDeps>[0],
  userId: string,
  productId: string,
): Promise<string> {
  const injected = tryGet<string>(ctx, 'planId');
  if (injected) return injected;

  const { db } = readDomainDeps(ctx);
  const latest = await db
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.userId, userId), eq(plans.productId, productId)))
    .orderBy(desc(plans.generatedAt))
    .limit(1);
  if (latest.length === 0) {
    throw new Error(
      'add_plan_item: no plan exists for this product. ' +
        'The coordinator must create a plans row before adding items — ' +
        'normally this happens at the start of a team run.',
    );
  }
  return latest[0].id;
}

export const addPlanItemTool: ToolDefinition<PlanItemInput, AddPlanItemResult> =
  buildTool({
    name: ADD_PLAN_ITEM_TOOL_NAME,
    description:
      'Create a single plan_items row. Supply kind + phase + userAction + ' +
      'scheduledAt (ISO) + title; optionally channel / skillName / params / ' +
      "description. Attached to the current week's plan automatically. " +
      'Safe to call many times in parallel when planning a week.',
    inputSchema: planItemInputSchema,
    isConcurrencySafe: true,
    isReadOnly: false,
    async execute(input, ctx): Promise<AddPlanItemResult> {
      const { db, userId, productId } = readDomainDeps(ctx);
      const planId = await resolvePlanId(ctx, userId, productId);

      const planItemId = crypto.randomUUID();
      await db.insert(planItems).values({
        id: planItemId,
        userId,
        productId,
        planId,
        kind: input.kind,
        userAction: input.userAction,
        phase: input.phase,
        channel: input.channel ?? null,
        scheduledAt: new Date(input.scheduledAt),
        skillName: input.skillName ?? null,
        params: input.params,
        title: input.title,
        description: input.description ?? null,
      });

      return { planItemId, planId };
    },
  });
