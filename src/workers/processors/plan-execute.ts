import type { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { planItems } from '@/lib/db/schema';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { PlanExecuteJobData } from '@/lib/queue/plan-execute';
import {
  dispatchPlanItem,
  type PlanItemKind,
} from '@/lib/plan-execute-dispatch';
import {
  canTransition,
  transition,
  type PlanItemState,
  type PlanItemUserAction,
} from '@/lib/plan-state';

const baseLog = createLogger('worker:plan-execute');

/**
 * Plan-execute dispatcher.
 *
 * Consumes a plan-execute job, resolves the skill via the dispatch
 * table, and — for Phase 7 — advances the plan_item's state without
 * running the actual LLM / post / send call. Phase 8's API endpoints
 * and Phase 12's frontend will wire the real invocations on top of
 * this scaffolding.
 *
 * State transitions performed here:
 *
 *  - phase='draft' + state='planned' + userAction='approve'
 *      → moves planned → drafted (skill call stubbed)
 *  - phase='execute' + state IN ('approved','planned'+auto)
 *      → moves planned/approved → executing → completed (stubbed)
 *
 * Any other combination is treated as a stale job (e.g. the item was
 * superseded between enqueue and pickup) and no-ops loudly via a
 * logger warning — the job succeeds so it doesn't retry into a dead
 * end.
 *
 * All state changes route through `transition()` so invalid moves
 * throw InvalidTransitionError and surface in the DLQ.
 */
export async function processPlanExecute(
  job: Job<PlanExecuteJobData>,
): Promise<void> {
  const log = loggerForJob(baseLog, job);
  const { planItemId, phase } = job.data;

  const [row] = await db
    .select({
      id: planItems.id,
      userId: planItems.userId,
      kind: planItems.kind,
      state: planItems.state,
      userAction: planItems.userAction,
      channel: planItems.channel,
      skillName: planItems.skillName,
    })
    .from(planItems)
    .where(eq(planItems.id, planItemId))
    .limit(1);

  if (!row) {
    log.warn(`plan_item ${planItemId} not found — dropping stale job`);
    return;
  }

  const current = {
    id: row.id,
    state: row.state as PlanItemState,
    userAction: row.userAction as PlanItemUserAction,
  };

  const route = dispatchPlanItem({
    kind: row.kind as PlanItemKind,
    channel: row.channel,
    skillName: row.skillName,
  });

  if (!route) {
    log.error(
      `plan_item ${planItemId}: no dispatch route for kind=${row.kind} channel=${row.channel ?? 'null'} — failing`,
    );
    await writeState(current, 'failed');
    return;
  }

  // ------------------------------------------------------------------
  // Draft phase
  // ------------------------------------------------------------------
  if (phase === 'draft') {
    if (!canTransition(current.state, 'drafted')) {
      log.warn(
        `plan_item ${planItemId}: draft phase fired but state is ${current.state} (expected planned) — skipping`,
      );
      return;
    }

    const skillName = route.draftSkill ?? row.skillName;
    if (!skillName) {
      log.error(
        `plan_item ${planItemId}: draft phase requested but no skill registered for kind=${row.kind}`,
      );
      await writeState(current, 'failed');
      return;
    }

    log.info(
      `plan_item ${planItemId}: draft phase → skill=${skillName} (Phase 7 stub: not invoking)`,
    );

    // Phase 7: state transition only. Phase 8 wires runSkill() here.
    await writeState(current, 'drafted');
    return;
  }

  // ------------------------------------------------------------------
  // Execute phase
  // ------------------------------------------------------------------
  if (phase === 'execute') {
    // Execute is valid from approved (normal flow) or planned+auto
    // (auto-action items skip review). Both must transition → executing
    // first.
    if (!canTransition(current.state, 'executing')) {
      log.warn(
        `plan_item ${planItemId}: execute phase fired but state is ${current.state} — skipping`,
      );
      return;
    }

    const skillName = route.executeSkill ?? row.skillName;
    if (!skillName) {
      log.info(
        `plan_item ${planItemId}: execute phase for kind=${row.kind} has no skill registered — treating as manual-completion`,
      );
      const afterExecuting = await writeState(current, 'executing');
      await writeState(afterExecuting, 'completed');
      return;
    }

    log.info(
      `plan_item ${planItemId}: execute phase → skill=${skillName} (Phase 7 stub: not invoking)`,
    );

    // Phase 7: flow through executing → completed without actually
    // running the side-effect. Phase 8 wires the real post/send
    // under the 'executing' window so failures can flip to 'failed'.
    const afterExecuting = await writeState(current, 'executing');
    await writeState(afterExecuting, 'completed');
    return;
  }

  log.error(
    `plan_item ${planItemId}: unknown phase "${phase}" — dropping job`,
  );
}

/**
 * Validate via the state machine (throws on illegal move), then UPDATE
 * the row. Returns the post-transition row object so the caller can
 * chain `writeState()` for multi-step transitions without re-selecting.
 */
interface RowLike {
  id: string;
  state: PlanItemState;
  userAction: PlanItemUserAction;
}

async function writeState(
  current: RowLike,
  to: PlanItemState,
): Promise<RowLike> {
  const next = transition(current, to);
  await db
    .update(planItems)
    .set({ state: to, updatedAt: sql`now()` })
    .where(eq(planItems.id, current.id));
  return next;
}
