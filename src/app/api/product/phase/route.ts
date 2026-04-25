import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products, strategicPaths, planItems } from '@/lib/db/schema';
import { derivePhase, type ProductState } from '@/lib/launch-phase';
import { validateLaunchDates } from '@/lib/launch-date-rules';
import { acquireRateLimit } from '@/lib/rate-limit';
import { getUserChannels } from '@/lib/user-channels';
import { ensureTeamExists } from '@/lib/team-provisioner';
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { createAutomationConversation } from '@/lib/team-conversation-helpers';
import { weekBounds } from '@/lib/week-bounds';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:product:phase');

const RATE_LIMIT_WINDOW_SECONDS = 60;

const requestBodySchema = z.object({
  state: z.enum(['mvp', 'launching', 'launched']),
  launchDate: z.string().datetime().nullable().optional(),
  launchedAt: z.string().datetime().nullable().optional(),
});

// weekBounds: see src/lib/week-bounds.ts

/**
 * POST /api/product/phase
 *
 * Strategic replan: "phase change, new path". The user has changed their
 * launch situation in Settings (mvp ↔ launching ↔ launched, and/or the
 * launch date shifted). We:
 *
 *   1. Validate per-state date rules.
 *   2. Update the `products` row (state + dates) and deactivate the active
 *      `strategic_paths` row atomically.
 *   3. Supersede this week's pre-approval `plan_items` so the Today UI
 *      clears stale entries immediately.
 *   4. Enqueue a team-run with `trigger='phase_transition'`. The
 *      coordinator delegates to growth-strategist (to write the new
 *      strategic path) then content-planner (to write the new week's
 *      plan_items). Both land via their domain tools; this route returns
 *      immediately with a runId.
 *
 * Phase E Day 3: replaces the legacy runSkill(strategic) + runSkill(tactical)
 * chain. The team-run is async — the client should subscribe to
 * `/api/team/events?runId=...` for progress. Drops the legacy `{ path,
 * plan, items }` response envelope.
 *
 * Sibling endpoint:
 *   POST /api/plan/replan — tactical replan (same-phase new-week). Use
 *   when the phase or launch date is unchanged. That route reuses the
 *   active strategic_path and only enqueues a weekly replan.
 *
 *   200 { success: true, runId, phase, itemsSuperseded }
 *   400 invalid_request / invalid_dates
 *   401 unauthorized
 *   404 no_product (user hasn't completed onboarding)
 *   429 rate_limited
 *   500 phase_change_failed
 */
export async function POST(request: NextRequest): Promise<Response> {
  const { log, traceId } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const rl = await acquireRateLimit(`phase:${userId}`, RATE_LIMIT_WINDOW_SECONDS);
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

  let body: z.infer<typeof requestBodySchema>;
  try {
    const json = await request.json();
    body = requestBodySchema.parse(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid body';
    return NextResponse.json(
      { error: 'invalid_request', detail: message },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }

  const dateErrors = validateLaunchDates({
    state: body.state,
    launchDate: body.launchDate ?? null,
    launchedAt: body.launchedAt ?? null,
  });
  if (dateErrors.length > 0) {
    return NextResponse.json(
      { error: 'invalid_dates', detail: dateErrors },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }

  const [product] = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);

  if (!product) {
    return NextResponse.json(
      { error: 'no_product' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }

  const launchDate = body.launchDate ? new Date(body.launchDate) : null;
  const launchedAt = body.launchedAt ? new Date(body.launchedAt) : null;
  const state = body.state as ProductState;
  const currentPhase = derivePhase({ state, launchDate, launchedAt });

  const userChannels = await getUserChannels(userId);
  const activeChannels = userChannels.length > 0 ? userChannels : ['x'];

  log.info(
    `phase change start user=${userId} state=${state} phase=${currentPhase} channels=${activeChannels.join(',')}`,
  );

  // Commit the pre-team-run state atomically: update product, supersede
  // this week's pre-approval items, deactivate the active strategic_path.
  // The team-run writes the NEW strategic_path + plan_items on its own
  // timeline via growth-strategist + content-planner tool calls.
  const { weekStart, weekEnd } = weekBounds(new Date());
  let itemsSuperseded = 0;
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(products)
        .set({
          state,
          launchDate,
          launchedAt,
          updatedAt: new Date(),
        })
        .where(eq(products.id, product.id));

      const superseded = await tx
        .update(planItems)
        .set({ state: 'superseded', updatedAt: sql`now()` })
        .where(
          and(
            eq(planItems.userId, userId),
            gte(planItems.scheduledAt, weekStart),
            lt(planItems.scheduledAt, weekEnd),
            inArray(planItems.state, ['planned', 'drafted', 'ready_for_review']),
            ne(planItems.userAction, 'manual'),
          ),
        )
        .returning({ id: planItems.id });
      itemsSuperseded = superseded.length;

      await tx
        .update(strategicPaths)
        .set({ isActive: false })
        .where(eq(strategicPaths.userId, userId));
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`phase tx failed user=${userId}: ${message}`);
    return NextResponse.json(
      { error: 'phase_change_failed', detail: message },
      { status: 500, headers: { 'x-trace-id': traceId } },
    );
  }

  // Enqueue the team-run. Growth-strategist writes the new strategic_path
  // via write_strategic_path (which activates it on insert); content-planner
  // writes the week's plan_items via add_plan_item.
  let runId: string;
  try {
    const { teamId, memberIds } = await ensureTeamExists(userId, product.id);
    const phaseNow = new Date();
    const goal =
      `Phase change for ${product.name}: the user updated their launch situation. ` +
      `New state: ${state}. New phase: ${currentPhase}. ` +
      `weekStart=${weekStart.toISOString()} now=${phaseNow.toISOString()} today=${phaseNow.toISOString().slice(0, 10)}. ` +
      (launchDate ? `Launch date: ${launchDate.toISOString().slice(0, 10)}. ` : '') +
      (launchedAt ? `Launched: ${launchedAt.toISOString().slice(0, 10)}. ` : '') +
      `Active channels: ${activeChannels.join(', ')}. ` +
      `Write a new strategic path reflecting the new phase (anchor thesisArc[0].weekStart to ${weekStart.toISOString().slice(0, 10)}), then plan the coming week. Pass weekStart + now to content-planner verbatim in its spawn prompt.`;

    const conversationId = await createAutomationConversation(
      teamId,
      'phase_transition',
    );
    const enqueued = await enqueueTeamRun({
      teamId,
      trigger: 'phase_transition',
      goal,
      rootMemberId: memberIds.coordinator,
      conversationId,
    });
    runId = enqueued.runId;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error(`phase enqueue failed user=${userId}: ${detail}`);
    return NextResponse.json(
      { error: 'phase_change_failed', detail },
      { status: 500, headers: { 'x-trace-id': traceId } },
    );
  }

  log.info(
    `phase change enqueued user=${userId} runId=${runId} superseded=${itemsSuperseded}`,
  );

  return NextResponse.json(
    {
      success: true,
      runId,
      phase: currentPhase,
      itemsSuperseded,
    },
    { headers: { 'x-trace-id': traceId } },
  );
}
