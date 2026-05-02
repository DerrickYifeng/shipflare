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
import { dispatchApprove } from '@/lib/approve-dispatch';
import {
  loadDispatchInputForDraft,
  findDraftIdForPlanItem,
} from '@/lib/approve-loaders';

const baseLog = createLogger('worker:plan-execute');

/**
 * Plan-execute dispatcher.
 *
 * After Phase J Task 2, content_post draft-phase rows are batched at
 * the sweeper layer (one content-manager(post_batch) team-run per user
 * per tick), so this processor no longer fires per-row writer team-runs.
 * The remaining cases are:
 *
 *  - **Legacy state-machine stub** for every (kind, phase) combination
 *    that has a dispatch-table entry. Drives the row through state
 *    transitions and, for content posts in the EXECUTE phase, hands
 *    off to the posting dispatcher (`dispatchApprove`).
 *
 *    State transitions for the legacy path:
 *     - phase='draft' + state='planned' → moves planned → drafted
 *     - phase='execute' + state IN ('approved','planned'+auto) → moves
 *       planned/approved → executing → completed
 *
 *  - Any (kind, phase) without a dispatch-table entry is treated as a
 *    stale job and the row is failed loudly. The job succeeds so
 *    BullMQ doesn't retry into a dead end.
 *
 * All state changes route through `transition()` so invalid moves throw
 * InvalidTransitionError and surface in the DLQ.
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
      productId: planItems.productId,
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

  const current: RowLike = {
    id: row.id,
    state: row.state as PlanItemState,
    userAction: row.userAction as PlanItemUserAction,
  };

  // Phase J: content_post draft is now batched via content-manager in
  // plan-execute-sweeper. Any residual draft-phase job for content_post
  // (e.g. enqueued before the rewrite landed, or against a row already
  // claimed by the sweeper) is a no-op — the sweeper owns the dispatch
  // and `draft_post` owns the state flip.
  if (phase === 'draft' && row.kind === 'content_post') {
    log.info(
      `plan_item ${planItemId}: residual content_post draft job ignored — owned by plan-execute-sweeper batch`,
    );
    return;
  }

  // ------------------------------------------------------------------
  // Legacy dispatch-table path
  // ------------------------------------------------------------------
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
      `plan_item ${planItemId}: draft phase → skill=${skillName} (legacy stub: state transition only)`,
    );
    await writeState(current, 'drafted');
    return;
  }

  if (phase === 'execute') {
    if (!canTransition(current.state, 'executing')) {
      log.warn(
        `plan_item ${planItemId}: execute phase fired but state is ${current.state} — skipping`,
      );
      return;
    }

    // For content_post / content_reply with a known channel, route via the
    // dispatcher (same code path as the manual approve API). Anything else
    // (email_send, runsheet_beat, etc.) keeps the legacy state-only stub
    // until a future phase wires its execute path.
    const isContent =
      (row.kind === 'content_post' || row.kind === 'content_reply') &&
      (row.channel === 'x' || row.channel === 'reddit');

    if (!isContent) {
      log.info(
        `plan_item ${planItemId}: execute phase for kind=${row.kind} has no dispatcher route — manual completion`,
      );
      const afterExecuting = await writeState(current, 'executing');
      await writeState(afterExecuting, 'completed');
      return;
    }

    const draftId = await findDraftIdForPlanItem(planItemId);
    if (!draftId) {
      log.warn(
        `plan_item ${planItemId}: no linked pending draft found — leaving in current state for manual retry`,
      );
      return;
    }

    const dispatchInput = await loadDispatchInputForDraft(draftId, row.userId);
    if (!dispatchInput) {
      log.warn(
        `plan_item ${planItemId}: draft ${draftId} could not load (channel missing?) — leaving in current state`,
      );
      return;
    }

    // Dispatch FIRST so we only advance to 'executing' for outcomes that
    // actually start posting. Handoff and deferred outcomes leave the row
    // in 'approved' — both 'executing → approved' would be an illegal SM
    // transition (only 'completed'/'failed' exit 'executing').
    const decision = await dispatchApprove(dispatchInput);

    if (decision.kind === 'handoff') {
      // Auto-execute can't open a browser. X replies stay in 'approved'
      // until the user manually clicks the card to trigger the handoff.
      log.info(
        `plan_item ${planItemId}: X reply requires manual handoff — leaving state at 'approved' for user action`,
      );
      return;
    }

    if (decision.kind === 'deferred') {
      log.info(
        `plan_item ${planItemId}: pacer deferred (${decision.reason}) — leaving state at 'approved'; sweeper will retry`,
      );
      return;
    }

    // queued — only NOW advance to 'executing'. The posting worker will
    // write 'completed' or 'failed' (per Task 9) when the job finishes.
    await writeState(current, 'executing');
    // queued — posting worker will set plan_item.state = completed on success
    // (per Task 9, posting.ts now writes back to plan_items).
    log.info(`plan_item ${planItemId}: queued for posting (delay ${decision.delayMs}ms)`);
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
