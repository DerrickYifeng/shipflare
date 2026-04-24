// update_plan_item — UPDATE a plan_items row by id, scoped to the
// caller's (userId, productId) so an agent cannot steer another user's
// plans.

import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { planItems, planItemStateEnum } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';

export const UPDATE_PLAN_ITEM_TOOL_NAME = 'update_plan_item';

/**
 * States the agent is NOT allowed to transition *out of*. Once an item
 * is executing or reached a completed terminal, we treat the row as
 * immutable for audit — founders and downstream workers depend on the
 * historical fact of "this was run at time T". Agents can still flip
 * planned → superseded (cancelling a future item) but not
 * completed → superseded (rewriting history).
 */
const TERMINAL_STATES = new Set([
  'executing',
  'completed',
  'failed',
]);

const planItemStateValues = planItemStateEnum.enumValues as unknown as [
  string,
  ...string[],
];

const userActionValues = ['auto', 'approve', 'manual'] as const;

/** Subset of plan_items fields a planner is allowed to patch. */
export const updatePlanItemPatchSchema = z
  .object({
    state: z.enum(planItemStateValues).nullish(),
    userAction: z.enum(userActionValues).nullish(),
    scheduledAt: z.string().min(1).nullish(), // ISO
    title: z.string().min(1).max(200).nullish(),
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
  | {
      updated: false;
      reason: 'not_found' | 'not_owner' | 'empty_patch' | 'terminal_state';
    };

export const updatePlanItemTool: ToolDefinition<
  UpdatePlanItemInput,
  UpdatePlanItemResult
> = buildTool({
  name: UPDATE_PLAN_ITEM_TOOL_NAME,
  description:
    'Patch a single plan_items row by id. Editable fields: state ' +
    `(${planItemStateValues.join(', ')}), userAction ` +
    `(${userActionValues.join(', ')}), scheduledAt (ISO), title, ` +
    'description. Scoped to the current user + product. REFUSES ' +
    'rows already in `executing` / `completed` / `failed` — those are ' +
    'frozen for audit; use add_plan_item to schedule a follow-up ' +
    'instead of rewriting history.',
  inputSchema: updatePlanItemInputSchema,
  // Serialize updates for the same id; the database handles cross-id
  // concurrency fine, but concurrency-safe=false signals the runner that
  // two patches for the same id in one turn should be batched, not raced.
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input, ctx): Promise<UpdatePlanItemResult> {
    const { db, userId, productId } = readDomainDeps(ctx);

    // Drop null/undefined keys up-front — nullish schema lets LLMs pass
    // `{ title: null }` to mean "no change" without tripping validation,
    // so we coerce that shape into the "empty_patch" signal here.
    const patch = Object.fromEntries(
      Object.entries(input.patch).filter(
        ([k, v]) => v !== undefined && !(k !== 'description' && v === null),
      ),
    ) as typeof input.patch;

    if (Object.keys(patch).length === 0) {
      return { updated: false, reason: 'empty_patch' };
    }

    // Pre-check existence + ownership + terminal state so we return a
    // structured reason rather than a silent UPDATE ... WHERE 0 rows.
    const existing = await db
      .select({
        id: planItems.id,
        userId: planItems.userId,
        productId: planItems.productId,
        state: planItems.state,
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
    if (TERMINAL_STATES.has(row.state)) {
      return { updated: false, reason: 'terminal_state' };
    }

    const setValues: Record<string, unknown> = {
      updatedAt: sql`now()`,
    };
    if (patch.state != null) setValues.state = patch.state;
    if (patch.userAction != null) setValues.userAction = patch.userAction;
    if (patch.scheduledAt != null) {
      setValues.scheduledAt = new Date(patch.scheduledAt);
    }
    if (patch.title != null) setValues.title = patch.title;
    if (patch.description !== undefined) {
      // `description` is the one field where `null` is meaningful —
      // explicitly clearing the description.
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
