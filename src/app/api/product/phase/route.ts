import { NextResponse, type NextRequest } from 'next/server';
import { join } from 'node:path';
import { z } from 'zod';
import { and, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
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
  strategicPathSchema,
  tacticalPlanSchema,
  type StrategicPath,
  type TacticalPlan,
} from '@/agents/schemas';
import { derivePhase, type ProductState } from '@/lib/launch-phase';
import { validateLaunchDates } from '@/lib/launch-date-rules';
import { acquireRateLimit } from '@/lib/rate-limit';
import { getUserChannels } from '@/lib/user-channels';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:product:phase');

const CHAIN_TIMEOUT_MS = 60_000;
const RATE_LIMIT_WINDOW_SECONDS = 60;

const strategicSkill = loadSkill(
  join(process.cwd(), 'src/skills/strategic-planner'),
);
const tacticalSkill = loadSkill(
  join(process.cwd(), 'src/skills/tactical-planner'),
);

const catalogProjection = SKILL_CATALOG.map((s) => ({
  name: s.name,
  description: s.description,
  supportedKinds: [...s.supportedKinds],
  ...(s.channels ? { channels: [...s.channels] } : {}),
}));

const requestBodySchema = z.object({
  state: z.enum(['mvp', 'launching', 'launched']),
  launchDate: z.string().datetime().nullable().optional(),
  launchedAt: z.string().datetime().nullable().optional(),
});

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
 * POST /api/product/phase
 *
 * Strategic replan: the user has changed their launch situation in
 * Settings. Validates per-state date rules, updates the products row,
 * deactivates the current strategic_path, runs the strategic-planner +
 * tactical-planner chain, and replaces this week's pre-approval
 * plan_items.
 *
 * Replaces the old v1 PUT /api/product/phase route that just toggled
 * lifecyclePhase without re-planning.
 *
 *   200 { success: true, strategicPathId, planId, items }
 *   400 invalid_request / invalid_dates
 *   401 unauthorized
 *   404 no_product (user hasn't completed onboarding)
 *   429 rate_limited
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

  // Load the existing product. 404 when user hasn't completed onboarding.
  const [product] = await db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
      valueProp: products.valueProp,
      keywords: products.keywords,
      category: products.category,
      targetAudience: products.targetAudience,
    })
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
  // Fall back to ['x'] so a user with zero connected channels still gets a
  // plan (they can only execute X-shaped skills, which is fine — the strategic
  // planner needs at least one channel to write channelMix against).
  const plannerChannels = userChannels.length > 0 ? userChannels : ['x'];

  log.info(
    `phase change start user=${userId} state=${state} phase=${currentPhase} channels=${plannerChannels.join(',')}`,
  );

  // Run strategic + tactical chain. Same pattern as /api/onboarding/plan
  // but persisted rather than previewed.
  const { weekStart, weekEnd } = weekBounds(new Date());
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHAIN_TIMEOUT_MS);

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () =>
      reject(new Error('planner_timeout')),
    );
  });

  let path: StrategicPath;
  let plan: TacticalPlan;
  try {
    const strategicRes = await Promise.race([
      runSkill<StrategicPath>({
        skill: strategicSkill,
        input: {
          product: {
            name: product.name,
            description: product.description,
            valueProp: product.valueProp,
            keywords: product.keywords,
            category: product.category ?? 'other',
            targetAudience: product.targetAudience,
          },
          state,
          currentPhase,
          launchDate: launchDate ? launchDate.toISOString() : null,
          launchedAt: launchedAt ? launchedAt.toISOString() : null,
          channels: plannerChannels,
          voiceProfile: null,
          recentMilestones: [],
        },
        outputSchema: strategicPathSchema,
      }),
      timeoutPromise,
    ]);

    if (strategicRes.errors.length > 0) {
      throw new Error(
        `strategic-planner: ${strategicRes.errors.map((e) => e.error).join('; ')}`,
      );
    }
    const maybePath = strategicRes.results[0];
    if (!maybePath) throw new Error('strategic-planner returned no result');
    path = maybePath;

    const tacticalRes = await Promise.race([
      runSkill<TacticalPlan>({
        skill: tacticalSkill,
        input: {
          strategicPath: {
            narrative: path.narrative,
            thesisArc: path.thesisArc,
            contentPillars: path.contentPillars,
            channelMix: path.channelMix,
            phaseGoals: path.phaseGoals,
            milestones: path.milestones,
          },
          product: {
            name: product.name,
            valueProp: product.valueProp,
            currentPhase,
            state,
            launchDate: launchDate ? launchDate.toISOString() : null,
            launchedAt: launchedAt ? launchedAt.toISOString() : null,
          },
          channels: plannerChannels,
          weekStart: weekStart.toISOString(),
          weekEnd: weekEnd.toISOString(),
          signals: {
            recentMilestones: [],
            recentMetrics: [],
            stalledItems: [],
            completedLastWeek: [],
            currentLaunchTasks: [],
          },
          skillCatalog: catalogProjection,
          voiceBlock: null,
        },
        outputSchema: tacticalPlanSchema,
      }),
      timeoutPromise,
    ]);

    clearTimeout(timeoutId);

    if (tacticalRes.errors.length > 0) {
      throw new Error(
        `tactical-planner: ${tacticalRes.errors.map((e) => e.error).join('; ')}`,
      );
    }
    const maybePlan = tacticalRes.results[0];
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
    log.error(`phase chain failed user=${userId}: ${message}`);
    return NextResponse.json(
      { error: 'replan_failed', detail: message },
      { status: 500, headers: { 'x-trace-id': traceId } },
    );
  }

  // Commit: update product, supersede current week's pre-approval items,
  // deactivate old path, insert new path + plan + items.
  let strategicPathId: string;
  let planId: string;
  try {
    ({ strategicPathId, planId } = await db.transaction(async (tx) => {
      await tx
        .update(products)
        .set({
          state,
          launchDate,
          launchedAt,
          updatedAt: new Date(),
        })
        .where(eq(products.id, product.id));

      await tx
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
        );

      await tx
        .update(strategicPaths)
        .set({ isActive: false })
        .where(eq(strategicPaths.userId, userId));

      const [pathRow] = await tx
        .insert(strategicPaths)
        .values({
          userId,
          productId: product.id,
          isActive: true,
          phase: currentPhase,
          launchDate,
          launchedAt,
          narrative: path.narrative,
          milestones: path.milestones,
          thesisArc: path.thesisArc,
          contentPillars: path.contentPillars,
          channelMix: path.channelMix,
          phaseGoals: path.phaseGoals,
        })
        .returning({ id: strategicPaths.id });

      const [planRow] = await tx
        .insert(plans)
        .values({
          userId,
          productId: product.id,
          strategicPathId: pathRow.id,
          trigger: 'manual',
          weekStart,
          notes: plan.plan.notes,
        })
        .returning({ id: plans.id });

      if (plan.items.length > 0) {
        await tx.insert(planItems).values(
          plan.items.map((item) => ({
            userId,
            productId: product.id,
            planId: planRow.id,
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
      }

      return { strategicPathId: pathRow.id, planId: planRow.id };
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`phase tx failed user=${userId}: ${message}`);
    return NextResponse.json(
      { error: 'replan_failed', detail: message },
      { status: 500, headers: { 'x-trace-id': traceId } },
    );
  }

  log.info(
    `phase change done user=${userId} path=${strategicPathId} plan=${planId} items=${plan.items.length}`,
  );

  return NextResponse.json(
    {
      success: true,
      strategicPathId,
      planId,
      items: plan.items.length,
    },
    { headers: { 'x-trace-id': traceId } },
  );
}
