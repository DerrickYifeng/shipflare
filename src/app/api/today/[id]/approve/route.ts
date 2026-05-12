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
import { synthesizeContentPostDraft } from '@/lib/synthesize-content-post-draft';

const baseLog = createLogger('api:today:approve');

/**
 * PATCH /api/today/:id/approve
 *
 * Approves a plan_item or a draft (reply-card path).
 *
 * - plan_item id: transitions to 'approved', then dispatches via
 *   dispatchApprove using one of three strategies:
 *
 *   1. Linked draft found (content_reply path): load it and dispatch.
 *   2. No linked draft + kind='content_post': synthesise a draft from
 *      plan_items.output.draft_body (Task 13) and dispatch. The sweeper
 *      only creates drafts rows for state='planned' rows, so content_post
 *      plan_items that reach 'approved' via the /today click don't have a
 *      pre-existing draft until we create one here.
 *   3. Everything else: fall back to legacy enqueuePlanExecute so
 *      email_send / interview / setup_task etc. still flow through
 *      the plan-execute worker.
 *
 * - draft id (status='pending'): dispatches directly via dispatchApprove.
 *
 * Dispatcher outcomes:
 *   handoff  → 200 { success: true, browserHandoff: { intentUrl } }
 *   queued   → 200 { success: true }
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

    // Task 13: synthesise a draft for content_post plan_items that don't
    // yet have a drafts row (the sweeper only creates drafts for
    // state='planned'; the /today click approves them directly).
    if (planRow.kind === 'content_post' && planRow.channel) {
      const synth = await synthesizeContentPostDraft(planRow, session.user.id);
      if (synth) {
        const dispatchInput = await loadDispatchInputForDraft(
          synth.draftId,
          planRow.userId,
        );
        if (dispatchInput) {
          const decision = await dispatchApprove(dispatchInput);
          return applyDispatchResult(decision, synth.draftId, traceId, log);
        }
      }
    }

    // True fallback: still enqueue plan-execute for kinds we don't handle
    // here (email_send, interview, setup_task, etc.).
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
  // queued
  await db
    .update(drafts)
    .set({ status: 'approved', updatedAt: new Date() })
    .where(eq(drafts.id, draftId));
  log.info(`draft ${draftId} queued for posting`);
  return NextResponse.json(
    { success: true },
    { headers: { 'x-trace-id': traceId } },
  );
}
