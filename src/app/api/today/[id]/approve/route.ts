import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { enqueuePlanExecute } from '@/lib/queue';
import {
  findOwnedPlanItem,
  paramsSchema,
  writePlanItemState,
} from '@/app/api/plan-item/[id]/_helpers';
import { createLogger, loggerForRequest } from '@/lib/logger';
import { db } from '@/lib/db';
import { drafts, threads, channels } from '@/lib/db/schema';
import { dispatchApprove, type DispatchInput } from '@/lib/approve-dispatch';

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
    const rejection = await writePlanItemState(planRow, 'approved');
    if (rejection) return rejection;

    const draftId = await findDraftForPlanItem(planRow.id);
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
 * Load a draft + its thread + the user's channel for that platform, shaped
 * for `dispatchApprove`. Returns null if any of the joins miss.
 */
async function loadDispatchInputForDraft(
  draftId: string,
  userId: string,
): Promise<DispatchInput | null> {
  const [row] = await db
    .select({
      draftId: drafts.id,
      draftUserId: drafts.userId,
      draftThreadId: drafts.threadId,
      draftType: drafts.draftType,
      replyBody: drafts.replyBody,
      planItemId: drafts.planItemId,
      threadId: threads.id,
      threadPlatform: threads.platform,
      threadExternalId: threads.externalId,
    })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.userId, userId),
        eq(drafts.status, 'pending'),
      ),
    )
    .limit(1);

  if (!row) return null;

  const [channelRow] = await db
    .select({ id: channels.id, createdAt: channels.createdAt })
    .from(channels)
    .where(and(eq(channels.userId, userId), eq(channels.platform, row.threadPlatform)))
    .limit(1);

  if (!channelRow) return null;

  const connectedAgeDays = Math.max(
    0,
    Math.floor((Date.now() - channelRow.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
  );

  return {
    draft: {
      id: row.draftId,
      userId: row.draftUserId,
      threadId: row.draftThreadId,
      draftType: row.draftType === 'original_post' ? 'original_post' : 'reply',
      replyBody: row.replyBody,
      planItemId: row.planItemId,
    },
    thread: {
      id: row.threadId,
      platform: row.threadPlatform,
      externalId: row.threadExternalId,
    },
    channelId: channelRow.id,
    connectedAgeDays,
  };
}

/**
 * Find the draft linked to a plan_item (via drafts.planItemId === planItem.id).
 * Returns the draft id only — caller passes it to loadDispatchInputForDraft.
 */
async function findDraftForPlanItem(planItemId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.planItemId, planItemId), eq(drafts.status, 'pending')))
    .limit(1);
  return row?.id ?? null;
}

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
