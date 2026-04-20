import { join } from 'node:path';
import { and, eq, gte, lt, inArray, ne, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { planItems, products, strategicPaths, plans } from '@/lib/db/schema';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { SKILL_CATALOG } from '@/skills/_catalog';
import { tacticalPlanSchema, type TacticalPlan } from '@/agents/schemas';
import { derivePhase, type ProductState } from '@/lib/launch-phase';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:re-plan');

/**
 * Tactical re-plan supersede — see spec §7.1.
 *
 * Marks items inside `[weekStart, weekEnd)` that are still in a
 * pre-approval state as `superseded`. Leaves `approved / executing /
 * completed / skipped / failed / stale` alone so in-flight work and
 * finished history are preserved.
 *
 * `manual` userAction items (interviews, setup tasks) are NEVER
 * superseded — the founder is committed to them, so the planner
 * doesn't get to reshuffle them mid-week.
 *
 * The caller runs this BEFORE inserting the new plan's items so the
 * 7-day window is cleaned out in one pass. Returns the count of rows
 * marked.
 *
 * Idempotent: calling twice with the same args has no additional
 * effect on the second call (all target rows have already moved out
 * of the three pre-approval states).
 */
export interface SupersedeWindow {
  userId: string;
  /** ISO (inclusive). Typically Monday 00:00 UTC. */
  windowStart: Date;
  /** ISO (exclusive). Typically `windowStart + 7d`. */
  windowEnd: Date;
  /**
   * Optional filter. When present, only items with
   * `kind IN kinds` get superseded. Default: all kinds
   * (the normal Monday replan sweep).
   */
  kinds?: string[];
}

const PRE_APPROVAL_STATES = ['planned', 'drafted', 'ready_for_review'] as const;

export async function supersedePlanItems(
  input: SupersedeWindow,
): Promise<number> {
  const { userId, windowStart, windowEnd, kinds } = input;

  if (windowEnd.getTime() <= windowStart.getTime()) {
    throw new Error(
      `supersedePlanItems: windowEnd (${windowEnd.toISOString()}) must be after windowStart (${windowStart.toISOString()})`,
    );
  }

  const conditions = [
    eq(planItems.userId, userId),
    gte(planItems.scheduledAt, windowStart),
    lt(planItems.scheduledAt, windowEnd),
    inArray(planItems.state, [...PRE_APPROVAL_STATES]),
    ne(planItems.userAction, 'manual'),
  ];
  if (kinds && kinds.length > 0) {
    conditions.push(inArray(planItems.kind, kinds as never[]));
  }

  const result = await db
    .update(planItems)
    .set({ state: 'superseded', updatedAt: sql`now()` })
    .where(and(...conditions))
    .returning({ id: planItems.id });

  const count = result.length;
  log.info(
    `superseded ${count} plan_items user=${userId} window=${windowStart.toISOString()}..${windowEnd.toISOString()}` +
      (kinds ? ` kinds=[${kinds.join(',')}]` : ''),
  );
  return count;
}

/**
 * Strategic re-plan supersede — see spec §7.2.
 *
 * Different from tactical: it deactivates ALL active strategic paths
 * for the user (there should only be one, but the uniqueness
 * constraint is partial so we defensively scan) and supersedes every
 * pre-approval plan_item regardless of window. The caller then runs
 * strategic-planner + tactical-planner to rebuild.
 *
 * This is the "phase change" / "launch date change" path. Accept the
 * cost of resetting the whole pipeline; it's infrequent.
 */
export async function supersedeForStrategicReplan(
  userId: string,
): Promise<number> {
  const result = await db
    .update(planItems)
    .set({ state: 'superseded', updatedAt: sql`now()` })
    .where(
      and(
        eq(planItems.userId, userId),
        inArray(planItems.state, [...PRE_APPROVAL_STATES]),
        ne(planItems.userAction, 'manual'),
      ),
    )
    .returning({ id: planItems.id });

  const count = result.length;
  log.info(
    `strategic replan: superseded ${count} plan_items user=${userId} (all pre-approval, all windows)`,
  );
  return count;
}

// ---------------------------------------------------------------------------
// Tactical replan — shared between POST /api/plan/replan and the Monday
// weekly-replan cron processor. Callers choose the `trigger` value
// (`manual` vs `cron`) for the plans row.
// ---------------------------------------------------------------------------

const PLAN_TIMEOUT_MS = 45_000;

const tacticalSkillLazy = (() => {
  let cached: ReturnType<typeof loadSkill> | null = null;
  return () => {
    if (!cached) {
      cached = loadSkill(join(process.cwd(), 'src/skills/tactical-planner'));
    }
    return cached;
  };
})();

const catalogProjection = SKILL_CATALOG.map((s) => ({
  name: s.name,
  description: s.description,
  supportedKinds: [...s.supportedKinds],
  ...(s.channels ? { channels: [...s.channels] } : {}),
}));

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

export type ReplanTrigger = 'manual' | 'weekly';

export type ReplanResult =
  | {
      ok: true;
      plan: TacticalPlan;
      itemsInserted: number;
      itemsSuperseded: number;
    }
  | { ok: false; code: 'no_active_path' | 'no_channels_in_path' | 'planner_timeout' | 'planner_failed'; detail?: string };

/**
 * Load the user's product + active strategic path, run the tactical
 * planner, and atomically supersede + insert the week's items.
 *
 * Shared between:
 *   - POST /api/plan/replan (trigger='manual', user-initiated)
 *   - workers/processors/weekly-replan.ts (trigger='cron', Monday 00:00 UTC)
 *
 * Does NOT acquire a lock — callers handle deduplication: the API route
 * via the request rate limit, the cron via the per-(user, week) Redis lock.
 */
export async function runTacticalReplan(
  userId: string,
  trigger: ReplanTrigger,
): Promise<ReplanResult> {
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

  if (!row) return { ok: false, code: 'no_active_path' };

  const state = row.state as ProductState;
  const currentPhase = derivePhase({
    state,
    launchDate: row.launchDate ?? null,
    launchedAt: row.launchedAt ?? null,
  });
  const { weekStart, weekEnd } = weekBounds(new Date());

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

  const channels: Array<'x' | 'reddit' | 'email'> = [];
  const channelMix = row.pathChannelMix as Record<string, unknown> | null;
  if (channelMix) {
    for (const k of ['x', 'reddit', 'email'] as const) {
      if (channelMix[k]) channels.push(k);
    }
  }
  if (channels.length === 0) return { ok: false, code: 'no_channels_in_path' };

  log.info(
    `replan start user=${userId} trigger=${trigger} phase=${currentPhase} channels=[${channels.join(',')}] weekStart=${weekStart.toISOString()}`,
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PLAN_TIMEOUT_MS);

  let plan: TacticalPlan;
  try {
    const res = await Promise.race([
      runSkill<TacticalPlan>({
        skill: tacticalSkillLazy(),
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
            launchDate: row.launchDate ? row.launchDate.toISOString() : null,
            launchedAt: row.launchedAt ? row.launchedAt.toISOString() : null,
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
      return {
        ok: false,
        code: 'planner_failed',
        detail: `tactical-planner error: ${res.errors.map((e) => e.error).join('; ')}`,
      };
    }
    const maybePlan = res.results[0];
    if (!maybePlan) {
      return { ok: false, code: 'planner_failed', detail: 'no plan result' };
    }
    plan = maybePlan;
  } catch (err) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'planner_timeout') {
      return { ok: false, code: 'planner_timeout' };
    }
    return { ok: false, code: 'planner_failed', detail: message };
  }

  let itemsInserted = 0;
  let itemsSuperseded = 0;
  try {
    await db.transaction(async (tx) => {
      const superseded = await tx
        .update(planItems)
        .set({ state: 'superseded' })
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

      const [planRow] = await tx
        .insert(plans)
        .values({
          userId,
          productId: row.productId,
          strategicPathId: row.pathId,
          trigger,
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
    return { ok: false, code: 'planner_failed', detail: `tx_failed: ${message}` };
  }

  log.info(
    `replan done user=${userId} trigger=${trigger} inserted=${itemsInserted} superseded=${itemsSuperseded}`,
  );

  return { ok: true, plan, itemsInserted, itemsSuperseded };
}
