import { NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { planItems } from '@/lib/db/schema';
import {
  transition,
  InvalidTransitionError,
  type PlanItemState,
  type PlanItemUserAction,
} from '@/lib/plan-state';

export const paramsSchema = z.object({ id: z.string().uuid() });

export interface OwnedRow {
  id: string;
  userId: string;
  state: PlanItemState;
  userAction: PlanItemUserAction;
  kind: string;
  channel: string | null;
  skillName: string | null;
}

/**
 * Look up a plan_item scoped by (itemId, userId). Returns null when
 * either the item doesn't exist or the row belongs to a different user
 * — both map to 404 (no information leakage about ownership).
 */
export async function findOwnedPlanItem(
  itemId: string,
  userId: string,
): Promise<OwnedRow | null> {
  const [row] = await db
    .select({
      id: planItems.id,
      userId: planItems.userId,
      state: planItems.state,
      userAction: planItems.userAction,
      kind: planItems.kind,
      channel: planItems.channel,
      skillName: planItems.skillName,
    })
    .from(planItems)
    .where(and(eq(planItems.id, itemId), eq(planItems.userId, userId)))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    state: row.state as PlanItemState,
    userAction: row.userAction as PlanItemUserAction,
    kind: row.kind,
    channel: row.channel ?? null,
    skillName: row.skillName ?? null,
  };
}

/**
 * Transition via the SM + persist. Returns NextResponse with an error
 * body on invalid move; otherwise returns null so the caller can
 * continue (e.g. enqueueing a downstream job).
 */
export async function writePlanItemState(
  row: OwnedRow,
  to: PlanItemState,
): Promise<Response | null> {
  try {
    transition({ id: row.id, state: row.state, userAction: row.userAction }, to);
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      return NextResponse.json(
        {
          error: 'invalid_transition',
          from: err.from,
          to: err.to,
        },
        { status: 409 },
      );
    }
    throw err;
  }

  await db
    .update(planItems)
    .set({ state: to, updatedAt: sql`now()` })
    .where(eq(planItems.id, row.id));

  return null;
}
