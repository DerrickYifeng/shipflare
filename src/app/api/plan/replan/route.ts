import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { acquireRateLimit } from '@/lib/rate-limit';
import { runTacticalReplan } from '@/lib/re-plan';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:plan:replan');

const RATE_LIMIT_WINDOW_SECONDS = 30;

/**
 * POST /api/plan/replan
 *
 * User-triggered tactical re-plan for the current week. Shares all of
 * its heavy lifting with the Monday cron processor via
 * `runTacticalReplan()` — see `src/lib/re-plan.ts`.
 *
 * NOT a strategic replan — phase changes + launch-date edits are
 * POST /api/product/phase.
 *
 *   200 { plan, itemsInserted, itemsSuperseded }
 *   401 unauthorized
 *   404 no_active_path (user hasn't completed onboarding)
 *   400 no_channels_in_path (strategic path has no channelMix — corrupt)
 *   429 rate_limited (1 / 30s)
 *   500 replan_failed
 *   504 planner_timeout
 */
export async function POST(request: NextRequest): Promise<Response> {
  const { log, traceId } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const rl = await acquireRateLimit(`replan:${userId}`, RATE_LIMIT_WINDOW_SECONDS);
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

  const result = await runTacticalReplan(userId, 'manual');

  if (!result.ok) {
    if (result.code === 'no_active_path') {
      return NextResponse.json(
        { error: 'no_active_path' },
        { status: 404, headers: { 'x-trace-id': traceId } },
      );
    }
    if (result.code === 'no_channels_in_path') {
      return NextResponse.json(
        { error: 'no_channels_in_path' },
        { status: 400, headers: { 'x-trace-id': traceId } },
      );
    }
    if (result.code === 'planner_timeout') {
      return NextResponse.json(
        { error: 'planner_timeout' },
        { status: 504, headers: { 'x-trace-id': traceId } },
      );
    }
    log.error(`replan failed user=${userId}: ${result.detail ?? 'unknown'}`);
    return NextResponse.json(
      { error: 'replan_failed', detail: result.detail },
      { status: 500, headers: { 'x-trace-id': traceId } },
    );
  }

  return NextResponse.json(
    {
      plan: result.plan,
      itemsInserted: result.itemsInserted,
      itemsSuperseded: result.itemsSuperseded,
    },
    { headers: { 'x-trace-id': traceId } },
  );
}
