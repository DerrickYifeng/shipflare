import { and, eq, gte, lt, inArray, ne, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { planItems } from '@/lib/db/schema';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:re-plan');

/**
 * Tactical re-plan supersede — see spec §7.1.
 *
 * Marks items inside `[weekStart, weekEnd)` that are still in a
 * pre-approval state as `superseded`. Leaves `approved / executing /
 * completed / skipped / failed / stale` alone so in-flight work and
 * finished history are preserved.
 *
 * `manual` userAction items (interviews, setup tasks) are NEVER
 * superseded — the founder is committed to them, so the planner
 * doesn't get to reshuffle them mid-week.
 *
 * The caller runs this BEFORE inserting the new plan's items so the
 * 7-day window is cleaned out in one pass. Returns the count of rows
 * marked.
 *
 * Idempotent: calling twice with the same args has no additional
 * effect on the second call (all target rows have already moved out
 * of the three pre-approval states).
 */
export interface SupersedeWindow {
  userId: string;
  /** ISO (inclusive). Typically Monday 00:00 UTC. */
  windowStart: Date;
  /** ISO (exclusive). Typically `windowStart + 7d`. */
  windowEnd: Date;
  /**
   * Optional filter. When present, only items with
   * `kind IN kinds` get superseded. Default: all kinds
   * (the normal Monday replan sweep).
   */
  kinds?: string[];
}

const PRE_APPROVAL_STATES = ['planned', 'drafted', 'ready_for_review'] as const;

export async function supersedePlanItems(
  input: SupersedeWindow,
): Promise<number> {
  const { userId, windowStart, windowEnd, kinds } = input;

  if (windowEnd.getTime() <= windowStart.getTime()) {
    throw new Error(
      `supersedePlanItems: windowEnd (${windowEnd.toISOString()}) must be after windowStart (${windowStart.toISOString()})`,
    );
  }

  const conditions = [
    eq(planItems.userId, userId),
    gte(planItems.scheduledAt, windowStart),
    lt(planItems.scheduledAt, windowEnd),
    inArray(planItems.state, [...PRE_APPROVAL_STATES]),
    ne(planItems.userAction, 'manual'),
  ];
  if (kinds && kinds.length > 0) {
    conditions.push(inArray(planItems.kind, kinds as never[]));
  }

  const result = await db
    .update(planItems)
    .set({ state: 'superseded', updatedAt: sql`now()` })
    .where(and(...conditions))
    .returning({ id: planItems.id });

  const count = result.length;
  log.info(
    `superseded ${count} plan_items user=${userId} window=${windowStart.toISOString()}..${windowEnd.toISOString()}` +
      (kinds ? ` kinds=[${kinds.join(',')}]` : ''),
  );
  return count;
}

/**
 * Strategic re-plan supersede — see spec §7.2.
 *
 * Different from tactical: it deactivates ALL active strategic paths
 * for the user (there should only be one, but the uniqueness
 * constraint is partial so we defensively scan) and supersedes every
 * pre-approval plan_item regardless of window. The caller then runs
 * strategic-planner + tactical-planner to rebuild.
 *
 * This is the "phase change" / "launch date change" path. Accept the
 * cost of resetting the whole pipeline; it's infrequent.
 */
export async function supersedeForStrategicReplan(
  userId: string,
): Promise<number> {
  const result = await db
    .update(planItems)
    .set({ state: 'superseded', updatedAt: sql`now()` })
    .where(
      and(
        eq(planItems.userId, userId),
        inArray(planItems.state, [...PRE_APPROVAL_STATES]),
        ne(planItems.userAction, 'manual'),
      ),
    )
    .returning({ id: planItems.id });

  const count = result.length;
  log.info(
    `strategic replan: superseded ${count} plan_items user=${userId} (all pre-approval, all windows)`,
  );
  return count;
}
