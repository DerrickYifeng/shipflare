import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import {
  findOwnedPlanItem,
  paramsSchema,
  writePlanItemState,
} from '../_helpers';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:plan-item:skip');

/**
 * POST /api/plan-item/:id/skip
 *
 * Transitions the item to `skipped` (terminal). Allowed from a handful
 * of pre-terminal states (`planned`, `drafted`, `ready_for_review`,
 * `approved`) so the user can skip at any point before the post goes
 * out. The SM blocks skips from executing / completed / already-
 * terminal states.
 *
 *   200 { success: true }
 *   401 unauthorized
 *   404 not found
 *   409 invalid_transition
 */
export async function POST(
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

  log.info(`plan_item ${row.id} skipped (from ${row.state})`);

  return NextResponse.json(
    { success: true },
    { headers: { 'x-trace-id': traceId } },
  );
}
