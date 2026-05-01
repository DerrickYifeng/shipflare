import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { enqueuePlanExecute } from '@/lib/queue';
import {
  findOwnedPlanItem,
  paramsSchema,
  writePlanItemState,
} from '@/app/api/plan-item/[id]/_helpers';
import { createLogger, loggerForRequest } from '@/lib/logger';
import { db } from '@/lib/db';
import { drafts } from '@/lib/db/schema';
import { dispatchApprove } from '@/lib/approve-dispatch';
import {
  loadDispatchInputForDraft,
  findDraftIdForPlanItem,
} from '@/lib/approve-loaders';

const baseLog = createLogger('api:today:approve');

/**
 * PATCH /api/today/:id/approve
 *
 * Approves a plan_item or a draft (reply-card path).
 *
 * - plan_item id: transitions to 'approved', then dispatches via
 *   dispatchApprove if a linked draft exists; falls back to legacy
 *   enqueuePlanExecute if no draft row is found.
 * - draft id (status='pending'): dispatches directly via dispatchApprove.
 *
 * Dispatcher outcomes:
 *   handoff  → 200 { success: true, browserHandoff: { intentUrl } }
 *   queued   → 200 { success: true, queued: { delayMs } }
 *   deferred → 202 { success: false, deferred: true, reason, retryAfterMs }
 *
 * Error codes:
 *   400 invalid_id
 *   401 unauthorized
 *   404 not_found
 *   409 invalid_transition
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { log, traceId } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: rawId } = await params;
  const parsed = paramsSchema.safeParse({ id: rawId });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_id' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }

  // Try plan_item first (calendar / post cards), then fall back to draft
  // (reply cards from the discovery feed).
  const planRow = await findOwnedPlanItem(parsed.data.id, session.user.id);
  if (planRow) {
    // SM only allows `ready_for_review → approved`. Today UI surfaces rows
    // in `drafted | ready_for_review | approved`, so step through review
    // when the source state is `drafted`. (We have no automated review
    // gate; the user click IS the review.)
    if (planRow.state === 'drafted') {
      const stepped = await writePlanItemState(planRow, 'ready_for_review');
      if (stepped) return stepped;
      planRow.state = 'ready_for_review';
    }
    const rejection = await writePlanItemState(planRow, 'approved');
    if (rejection) return rejection;

    const draftId = await findDraftIdForPlanItem(planRow.id);
    if (draftId) {
      const dispatchInput = await loadDispatchInputForDraft(draftId, planRow.userId);
      if (dispatchInput) {
        const decision = await dispatchApprove(dispatchInput);
        return applyDispatchResult(decision, draftId, traceId, log);
      }
    }

    // Legacy fallback: no linked draft (content_post drafts live in
    // plan_items.output.draft_body for now). Enqueue plan-execute as
    // before — Task 13 will route this through the dispatcher too.
    await enqueuePlanExecute({
      schemaVersion: 1,
      planItemId: planRow.id,
      userId: planRow.userId,
      phase: 'execute',
      traceId,
    });
    log.info(`plan_item ${planRow.id} approved via /today (legacy enqueue)`);
    return NextResponse.json(
      { success: true },
      { headers: { 'x-trace-id': traceId } },
    );
  }

  // Reply-card path: id is a draft id
  const dispatchInput = await loadDispatchInputForDraft(parsed.data.id, session.user.id);
  if (dispatchInput) {
    const decision = await dispatchApprove(dispatchInput);
    return applyDispatchResult(decision, dispatchInput.draft.id, traceId, log);
  }

  return NextResponse.json(
    { error: 'not_found' },
    { status: 404, headers: { 'x-trace-id': traceId } },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Apply a dispatcher decision: do the DB writes and return the HTTP response.
 */
async function applyDispatchResult(
  decision: Awaited<ReturnType<typeof dispatchApprove>>,
  draftId: string,
  traceId: string,
  log: ReturnType<typeof createLogger>,
): Promise<Response> {
  if (decision.kind === 'handoff') {
    await db
      .update(drafts)
      .set({ status: 'handed_off', updatedAt: new Date() })
      .where(eq(drafts.id, draftId));
    log.info(`draft ${draftId} handed off to browser`);
    return NextResponse.json(
      { success: true, browserHandoff: { intentUrl: decision.intentUrl } },
      { headers: { 'x-trace-id': traceId } },
    );
  }
  if (decision.kind === 'deferred') {
    return NextResponse.json(
      {
        success: false,
        deferred: true,
        reason: decision.reason,
        retryAfterMs: decision.retryAfterMs,
      },
      { status: 202, headers: { 'x-trace-id': traceId } },
    );
  }
  // queued
  await db
    .update(drafts)
    .set({ status: 'approved', updatedAt: new Date() })
    .where(eq(drafts.id, draftId));
  log.info(`draft ${draftId} queued for posting (delay ${decision.delayMs}ms)`);
  return NextResponse.json(
    { success: true, queued: { delayMs: decision.delayMs } },
    { headers: { 'x-trace-id': traceId } },
  );
}
