import { NextResponse, type NextRequest } from 'next/server';
import { join } from 'node:path';
import { and, eq, gte, inArray, lt, ne } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  products,
  strategicPaths,
  plans,
  planItems,
} from '@/lib/db/schema';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { SKILL_CATALOG } from '@/skills/_catalog';
import {
  tacticalPlanSchema,
  type TacticalPlan,
} from '@/agents/schemas';
import { derivePhase, type ProductState } from '@/lib/launch-phase';
import { acquireRateLimit } from '@/lib/rate-limit';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:plan:replan');

const PLAN_TIMEOUT_MS = 45_000;
const RATE_LIMIT_WINDOW_SECONDS = 30;

const tacticalSkill = loadSkill(
  join(process.cwd(), 'src/skills/tactical-planner'),
);

const catalogProjection = SKILL_CATALOG.map((s) => ({
  name: s.name,
  description: s.description,
  supportedKinds: [...s.supportedKinds],
  ...(s.channels ? { channels: [...s.channels] } : {}),
}));

/**
 * Monday-anchored week bounds. Matches the tactical-planner's weekStart
 * semantics — replan only ever targets the current ISO week.
 */
function weekBounds(now: Date): { weekStart: Date; weekEnd: Date } {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  const dayOffset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayOffset);
  const weekStart = new Date(d);
  const weekEnd = new Date(d);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  return { weekStart, weekEnd };
}

/**
 * POST /api/plan/replan
 *
 * User-triggered tactical re-plan for the current week. Reads the
 * user's active strategic_path, runs the tactical-planner with the
 * current signals, supersedes the existing week's pre-approval items,
 * then inserts the new items inside one transaction.
 *
 * NOT a strategic replan — phase changes + launch-date edits are
 * POST /api/product/phase.
 *
 *   200 { plan, itemsInserted, itemsSuperseded }
 *   400 invalid_request
 *   401 unauthorized
 *   404 no_active_path (user hasn't completed onboarding)
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

  // Pull the user's product + active strategic path in a single pass so
  // we fail fast if either is missing.
  const [row] = await db
    .select({
      productId: products.id,
      productName: products.name,
      productValueProp: products.valueProp,
      state: products.state,
      launchDate: products.launchDate,
      launchedAt: products.launchedAt,
      pathId: strategicPaths.id,
      pathNarrative: strategicPaths.narrative,
      pathMilestones: strategicPaths.milestones,
      pathThesisArc: strategicPaths.thesisArc,
      pathContentPillars: strategicPaths.contentPillars,
      pathChannelMix: strategicPaths.channelMix,
      pathPhaseGoals: strategicPaths.phaseGoals,
    })
    .from(products)
    .innerJoin(
      strategicPaths,
      and(
        eq(strategicPaths.userId, products.userId),
        eq(strategicPaths.isActive, true),
      ),
    )
    .where(eq(products.userId, userId))
    .limit(1);

  if (!row) {
    return NextResponse.json(
      { error: 'no_active_path' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }

  const launchDate = row.launchDate ?? null;
  const launchedAt = row.launchedAt ?? null;
  const state = row.state as ProductState;
  const currentPhase = derivePhase({ state, launchDate, launchedAt });
  const { weekStart, weekEnd } = weekBounds(new Date());

  // Pull this week's completed / stalled / currentLaunchTasks so the
  // planner dedupes against them. Uses the plan_items columns that
  // survived Phase 1.
  const weekRows = await db
    .select({
      kind: planItems.kind,
      state: planItems.state,
      userAction: planItems.userAction,
      title: planItems.title,
    })
    .from(planItems)
    .where(
      and(
        eq(planItems.userId, userId),
        gte(planItems.scheduledAt, weekStart),
        lt(planItems.scheduledAt, weekEnd),
      ),
    );

  const completedLastWeek = weekRows
    .filter((r) => r.state === 'completed')
    .map((r) => ({ title: r.title, kind: r.kind }));
  const stalledItems = weekRows
    .filter((r) => r.state === 'stale' || r.state === 'failed')
    .map((r) => ({ title: r.title, kind: r.kind }));
  const currentLaunchTasks = weekRows
    .filter((r) => r.userAction === 'manual' && r.state !== 'completed')
    .map((r) => ({ title: r.title, kind: r.kind }));

  // Determine channel mix keys to pass to the planner.
  const channels: Array<'x' | 'reddit' | 'email'> = [];
  const channelMix = row.pathChannelMix as Record<string, unknown> | null;
  if (channelMix) {
    for (const k of ['x', 'reddit', 'email'] as const) {
      if (channelMix[k]) channels.push(k);
    }
  }
  if (channels.length === 0) {
    return NextResponse.json(
      { error: 'no_channels_in_path' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }

  log.info(
    `replan start user=${userId} phase=${currentPhase} channels=[${channels.join(',')}] weekStart=${weekStart.toISOString()}`,
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PLAN_TIMEOUT_MS);

  let plan: TacticalPlan;
  try {
    const res = await Promise.race([
      runSkill<TacticalPlan>({
        skill: tacticalSkill,
        input: {
          strategicPath: {
            narrative: row.pathNarrative,
            thesisArc: row.pathThesisArc,
            contentPillars: row.pathContentPillars,
            channelMix: row.pathChannelMix,
            phaseGoals: row.pathPhaseGoals,
            milestones: row.pathMilestones,
          },
          product: {
            name: row.productName,
            valueProp: row.productValueProp,
            currentPhase,
            state,
            launchDate: launchDate ? launchDate.toISOString() : null,
            launchedAt: launchedAt ? launchedAt.toISOString() : null,
          },
          channels,
          weekStart: weekStart.toISOString(),
          weekEnd: weekEnd.toISOString(),
          signals: {
            recentMilestones: [],
            recentMetrics: [],
            stalledItems,
            completedLastWeek,
            currentLaunchTasks,
          },
          skillCatalog: catalogProjection,
          voiceBlock: null,
        },
        outputSchema: tacticalPlanSchema,
      }),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(new Error('planner_timeout')),
        );
      }),
    ]);

    clearTimeout(timeoutId);

    if (res.errors.length > 0) {
      throw new Error(
        `tactical-planner error: ${res.errors.map((e) => e.error).join('; ')}`,
      );
    }
    const maybePlan = res.results[0];
    if (!maybePlan) throw new Error('tactical-planner returned no result');
    plan = maybePlan;
  } catch (err) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'planner_timeout') {
      return NextResponse.json(
        { error: 'planner_timeout' },
        { status: 504, headers: { 'x-trace-id': traceId } },
      );
    }
    log.error(`replan planner failed user=${userId}: ${message}`);
    return NextResponse.json(
      { error: 'replan_failed', detail: message },
      { status: 500, headers: { 'x-trace-id': traceId } },
    );
  }

  // Atomic: supersede this week's pre-approval items, then insert the new
  // items under a fresh plans row.
  let itemsSuperseded = 0;
  let itemsInserted = 0;
  try {
    await db.transaction(async (tx) => {
      // Supersede pre-approval rows in the window. Mirrors
      // supersedePlanItems() from src/lib/re-plan.ts but runs inside
      // the transaction so the insert + supersede land together.
      const superseded = await tx
        .update(planItems)
        .set({ state: 'superseded' })
        .where(
          and(
            eq(planItems.userId, userId),
            gte(planItems.scheduledAt, weekStart),
            lt(planItems.scheduledAt, weekEnd),
            inArray(planItems.state, [
              'planned',
              'drafted',
              'ready_for_review',
            ]),
            ne(planItems.userAction, 'manual'),
          ),
        )
        .returning({ id: planItems.id });
      itemsSuperseded = superseded.length;

      const [planRow] = await tx
        .insert(plans)
        .values({
          userId,
          productId: row.productId,
          strategicPathId: row.pathId,
          trigger: 'manual',
          weekStart,
          notes: plan.plan.notes,
        })
        .returning({ id: plans.id });
      const planId = planRow.id;

      if (plan.items.length > 0) {
        await tx.insert(planItems).values(
          plan.items.map((item) => ({
            userId,
            productId: row.productId,
            planId,
            kind: item.kind,
            userAction: item.userAction,
            phase: item.phase,
            channel: item.channel ?? null,
            scheduledAt: new Date(item.scheduledAt),
            skillName: item.skillName ?? null,
            params: item.params,
            title: item.title,
            description: item.description ?? null,
          })),
        );
        itemsInserted = plan.items.length;
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`replan tx failed user=${userId}: ${message}`);
    return NextResponse.json(
      { error: 'replan_failed', detail: message },
      { status: 500, headers: { 'x-trace-id': traceId } },
    );
  }

  log.info(
    `replan done user=${userId} inserted=${itemsInserted} superseded=${itemsSuperseded}`,
  );

  return NextResponse.json(
    { plan, itemsInserted, itemsSuperseded },
    { headers: { 'x-trace-id': traceId } },
  );
}
