import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import {
  findOwnedPlanItem,
  paramsSchema,
  writePlanItemState,
} from '@/app/api/plan-item/[id]/_helpers';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:today:skip');

/**
 * PATCH /api/today/:id/skip
 *
 * Thin shim over the plan-item SM. Transitions the plan_item to
 * `skipped` (terminal). The SM blocks skips from executing / already-
 * terminal states and returns 409 invalid_transition.
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

  const rejection = await writePlanItemState(row, 'skipped');
  if (rejection) return rejection;

  log.info(`plan_item ${row.id} skipped via /today`);
  return NextResponse.json(
    { success: true },
    { headers: { 'x-trace-id': traceId } },
  );
}
