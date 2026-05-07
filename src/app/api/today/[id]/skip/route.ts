import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import {
  findOwnedPlanItem,
  paramsSchema,
  writePlanItemState,
} from '@/app/api/plan-item/[id]/_helpers';
import { createLogger, loggerForRequest } from '@/lib/logger';
import { db } from '@/lib/db';
import { drafts } from '@/lib/db/schema';

const baseLog = createLogger('api:today:skip');

// State sets used for the skip gate. Listed inline so they read at the
// call site without a hop into shared state-machine config — same shape
// as the edit route's gate (see src/app/api/today/[id]/edit/route.ts).
const SKIPPABLE_DRAFT_STATUSES = new Set(['pending']);

/**
 * PATCH /api/today/:id/skip
 *
 * Skips a plan_item or a reply draft. The Today feed merges two data
 * sources; `:id` may resolve to either, so the handler tries plan_items
 * first (calendar / post cards), then falls back to the drafts table
 * (reply cards from the discovery feed).
 *
 *   plan_item path: SM transitions to `skipped` (terminal). The SM
 *     blocks skips from terminal / executing states with 409.
 *   drafts path:    only `status='pending'` is skippable. Anything past
 *     pending (approved, handed_off, posted, ...) is rejected with 409.
 *
 * Status codes:
 *   200  success
 *   400  invalid_id
 *   401  unauthorized
 *   404  not_found
 *   409  invalid_transition / not_skippable
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
  const userId = session.user.id;

  const { id: rawId } = await params;
  const parsed = paramsSchema.safeParse({ id: rawId });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_id' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }
  const id = parsed.data.id;

  // Plan-item path first — calendar / post cards land here.
  const planRow = await findOwnedPlanItem(id, userId);
  if (planRow) {
    const rejection = await writePlanItemState(planRow, 'skipped');
    if (rejection) return rejection;
    log.info(`plan_item ${planRow.id} skipped via /today`);
    return NextResponse.json(
      { success: true, source: 'plan_item' },
      { headers: { 'x-trace-id': traceId } },
    );
  }

  // Drafts path — reply cards. Scope by userId so we don't leak ownership.
  const draftRows = await db
    .select({
      id: drafts.id,
      userId: drafts.userId,
      status: drafts.status,
    })
    .from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.userId, userId)))
    .limit(1);

  const draft = draftRows[0];
  if (!draft) {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }
  if (!SKIPPABLE_DRAFT_STATUSES.has(draft.status)) {
    return NextResponse.json(
      { error: 'not_skippable', status: draft.status },
      { status: 409, headers: { 'x-trace-id': traceId } },
    );
  }

  await db
    .update(drafts)
    .set({ status: 'skipped', updatedAt: new Date() })
    .where(eq(drafts.id, draft.id));
  log.info(`draft ${draft.id} skipped via /today`);
  return NextResponse.json(
    { success: true, source: 'draft' },
    { headers: { 'x-trace-id': traceId } },
  );
}
