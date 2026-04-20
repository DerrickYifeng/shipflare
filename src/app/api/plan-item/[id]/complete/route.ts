import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import {
  findOwnedPlanItem,
  paramsSchema,
  writePlanItemState,
} from '../_helpers';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:plan-item:complete');

/**
 * POST /api/plan-item/:id/complete
 *
 * Manual completion. The founder ran an off-platform task
 * (interview, setup task) and is marking it done. Only valid when:
 *   - userAction === 'manual'
 *   - current state === 'planned'
 *
 * The SM allows planned → completed for manual items per spec §6.
 *
 *   200 { success: true }
 *   400 invalid_id
 *   401 unauthorized
 *   403 not_manual (userAction != 'manual')
 *   404 not found
 *   409 invalid_transition (not in planned state)
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

  // Guard rail: this endpoint is for manual items only. Auto / approve
  // items run through the plan-execute dispatcher.
  if (row.userAction !== 'manual') {
    return NextResponse.json(
      { error: 'not_manual', userAction: row.userAction },
      { status: 403, headers: { 'x-trace-id': traceId } },
    );
  }

  const rejection = await writePlanItemState(row, 'completed');
  if (rejection) return rejection;

  log.info(`plan_item ${row.id} manually completed by user`);

  return NextResponse.json(
    { success: true },
    { headers: { 'x-trace-id': traceId } },
  );
}
