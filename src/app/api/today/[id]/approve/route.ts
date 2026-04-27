import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { enqueuePlanExecute } from '@/lib/queue';
import {
  findOwnedPlanItem,
  paramsSchema,
  writePlanItemState,
} from '@/app/api/plan-item/[id]/_helpers';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:today:approve');

/**
 * PATCH /api/today/:id/approve
 *
 * Thin shim over POST /api/plan-item/:id/approve so the existing
 * `useToday()` hook can keep its PATCH signature. Ids are plan_item UUIDs
 * now — Today v3 renders plan_items directly.
 *
 *   200 { success: true }
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

  const row = await findOwnedPlanItem(parsed.data.id, session.user.id);
  if (!row) {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }

  const rejection = await writePlanItemState(row, 'approved');
  if (rejection) return rejection;

  await enqueuePlanExecute({
    schemaVersion: 1,
    planItemId: row.id,
    userId: row.userId,
    phase: 'execute',
    traceId,
  });

  log.info(`plan_item ${row.id} approved via /today`);
  return NextResponse.json(
    { success: true },
    { headers: { 'x-trace-id': traceId } },
  );
}
