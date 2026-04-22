// update_plan_item — UPDATE a plan_items row by id, scoped to the
// caller's (userId, productId) so an agent cannot steer another user's
// plans.

import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { planItems } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';

export const UPDATE_PLAN_ITEM_TOOL_NAME = 'update_plan_item';

/** Subset of plan_items fields a planner is allowed to patch. */
export const updatePlanItemPatchSchema = z
  .object({
    state: z
      .enum([
        'planned',
        'drafted',
        'ready_for_review',
        'approved',
        'executing',
        'completed',
        'skipped',
        'failed',
        'superseded',
        'stale',
      ])
      .optional(),
    scheduledAt: z.string().min(1).optional(), // ISO
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(600).nullable().optional(),
  })
  .strict();

export const updatePlanItemInputSchema = z
  .object({
    id: z.string().min(1, 'id is required'),
    patch: updatePlanItemPatchSchema,
  })
  .strict();

export type UpdatePlanItemInput = z.infer<typeof updatePlanItemInputSchema>;

export type UpdatePlanItemResult =
  | { updated: true }
  | { updated: false; reason: 'not_found' | 'not_owner' | 'empty_patch' };

export const updatePlanItemTool: ToolDefinition<
  UpdatePlanItemInput,
  UpdatePlanItemResult
> = buildTool({
  name: UPDATE_PLAN_ITEM_TOOL_NAME,
  description:
    'Patch a single plan_items row by id. Supports updating state, ' +
    'scheduledAt, title, description. Scoped to the current user + ' +
    'product — cannot modify other users\' rows.',
  inputSchema: updatePlanItemInputSchema,
  // Serialize updates for the same id; the database handles cross-id
  // concurrency fine, but concurrency-safe=false signals the runner that
  // two patches for the same id in one turn should be batched, not raced.
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input, ctx): Promise<UpdatePlanItemResult> {
    const { db, userId, productId } = readDomainDeps(ctx);

    if (Object.keys(input.patch).length === 0) {
      return { updated: false, reason: 'empty_patch' };
    }

    // Pre-check existence + ownership so we can return a structured
    // reason rather than a silent UPDATE ... WHERE 0 rows.
    const existing = await db
      .select({
        id: planItems.id,
        userId: planItems.userId,
        productId: planItems.productId,
      })
      .from(planItems)
      .where(eq(planItems.id, input.id))
      .limit(1);

    if (existing.length === 0) {
      return { updated: false, reason: 'not_found' };
    }
    const row = existing[0];
    if (row.userId !== userId || row.productId !== productId) {
      return { updated: false, reason: 'not_owner' };
    }

    const patch = input.patch;
    const setValues: Record<string, unknown> = {
      updatedAt: sql`now()`,
    };
    if (patch.state !== undefined) setValues.state = patch.state;
    if (patch.scheduledAt !== undefined) {
      setValues.scheduledAt = new Date(patch.scheduledAt);
    }
    if (patch.title !== undefined) setValues.title = patch.title;
    if (patch.description !== undefined) {
      setValues.description = patch.description;
    }

    await db
      .update(planItems)
      .set(setValues)
      .where(
        and(
          eq(planItems.id, input.id),
          eq(planItems.userId, userId),
          eq(planItems.productId, productId),
        ),
      );

    return { updated: true };
  },
});
