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
 * Tactical re-plan: "same phase, new week". The user already has an
 * active strategic_path (phase + launch date haven't changed); we
 * want fresh plan_items for the coming week based on current signals
 * (completed items, stalled items, new milestones). Runs ONLY the
 * tactical-planner — the strategic path is reused as-is.
 *
 * This is the same code path as the Monday weekly cron; both callers
 * go through `runTacticalReplan()` in `src/lib/re-plan.ts`, differing
 * only in the `plans.trigger` column value ('manual' here, 'weekly'
 * for the cron).
 *
 * Sibling endpoint:
 *   POST /api/product/phase — strategic replan. Use when the phase or
 *   launch dates actually changed. It deactivates the old strategic_path,
 *   runs strategic-planner + tactical-planner back-to-back, and replaces
 *   this week's pre-approval items. See that file's header for the
 *   full distinction.
 *
 * These two routes do NOT duplicate work — `replan` reads the active
 * path and preserves it; `phase` writes a new path. A user hitting
 * both in quick succession gets a fresh strategic path from `phase`,
 * then a fresh tactical plan from `replan`. The tactical plan from
 * `replan` supersedes the one `phase` just wrote for the current
 * week (both use the same transaction shape).
 *
 *   200 { plan, itemsInserted, itemsSuperseded }
 *   401 unauthorized
 *   404 no_active_path (user hasn't completed onboarding)
 *   400 no_channels_in_path (path has no channelMix, or all channels
 *        were disconnected in Settings — see re-plan.ts intersection logic)
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
    log.error(`replan failed user=${userId}: ${result.detail ?? 'unknown'}`);
    return NextResponse.json(
      { error: 'replan_failed', detail: result.detail },
      { status: 500, headers: { 'x-trace-id': traceId } },
    );
  }

  // Phase C: the team-run is async. We return the runId so the client
  // can subscribe to /api/team/events for progress; plan_items land via
  // add_plan_item tool_calls as the coordinator runs. Drop the legacy
  // `plan` field (terminal TacticalPlan object) — it doesn't exist in
  // the team-run shape.
  return NextResponse.json(
    {
      runId: result.runId,
      itemsSuperseded: result.itemsSuperseded,
    },
    { headers: { 'x-trace-id': traceId } },
  );
}
