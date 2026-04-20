import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { enqueuePlanExecute } from '@/lib/queue';
import { acquireRateLimit } from '@/lib/rate-limit';
import {
  findOwnedPlanItem,
  paramsSchema,
  writePlanItemState,
} from '../_helpers';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:plan-item:approve');

// 1 approve per second per user. Human click cadence is nowhere near
// this; the bound is specifically to stop a spammed button from
// hammering the plan-execute queue.
const RATE_LIMIT_WINDOW_SECONDS = 1;

/**
 * POST /api/plan-item/:id/approve
 *
 * Transitions the item `ready_for_review → approved` and enqueues
 * the `execute` phase via the plan-execute queue. The SM rejects
 * approvals from any state other than `ready_for_review` (spec §6).
 *
 *   200 { success: true }
 *   400 invalid id
 *   401 unauthorized
 *   404 item not found (or not owned by caller — no ownership leak)
 *   409 invalid_transition (already skipped / executing / etc.)
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

  const rl = await acquireRateLimit(
    `plan-item:approve:${session.user.id}`,
    RATE_LIMIT_WINDOW_SECONDS,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAfterSeconds: rl.retryAfterSeconds },
      {
        status: 429,
        headers: {
          'Retry-After': String(rl.retryAfterSeconds),
          'x-trace-id': traceId,
        },
      },
    );
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

  log.info(`plan_item ${row.id} approved → execute enqueued`);

  return NextResponse.json(
    { success: true },
    { headers: { 'x-trace-id': traceId } },
  );
}
