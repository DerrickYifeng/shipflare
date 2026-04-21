import type { Job } from 'bullmq';
import { join } from 'node:path';
import { and, eq, gte, lt } from 'drizzle-orm';
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
import { tacticalPlanSchema, type TacticalPlan } from '@/agents/schemas';
import { derivePhase, type ProductState } from '@/lib/launch-phase';
import { getUserChannels } from '@/lib/user-channels';
import { publishUserEvent } from '@/lib/redis';
import { recordPipelineEvent } from '@/lib/pipeline-events';
import { createLogger, loggerForJob } from '@/lib/logger';
import { getTraceId } from '@/lib/queue/types';
import type { TacticalGenerateJobData } from '@/lib/queue/tactical-generate';

const baseLog = createLogger('worker:tactical-generate');

const tacticalSkill = loadSkill(
  join(process.cwd(), 'src/skills/tactical-planner'),
);

const catalogProjection = SKILL_CATALOG.map((s) => ({
  name: s.name,
  description: s.description,
  supportedKinds: [...s.supportedKinds],
  ...(s.channels ? { channels: [...s.channels] } : {}),
}));

const PLAN_TIMEOUT_MS = 60_000;

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
 * Background tactical-planner execution scheduled by
 * `/api/onboarding/commit` after the user accepted their strategic path.
 *
 * Contract:
 *   - The commit route has already written products + strategic_paths +
 *     a header-only plans row (trigger='onboarding').
 *   - This processor runs tactical-planner and INSERTs plan_items
 *     against the supplied `planId`. It does NOT create a new plans row
 *     and does NOT supersede existing items — the row is brand new.
 *   - Emits `tactical_generate_*` pub/sub events on
 *     `shipflare:events:{userId}:agents` so the /today progress widget
 *     can track `started → completed|failed` without polling.
 *   - Also writes `launch_plan_*` rows to pipeline_events for audit
 *     forensics and the /today progress-snapshot endpoint.
 *
 * Retries up to 3x on transient failure (see queue config). On final
 * failure, the plans row gets a note explaining the failure so /today
 * can surface it rather than spin forever.
 */
export async function processTacticalGenerate(
  job: Job<TacticalGenerateJobData>,
): Promise<void> {
  const jlog = loggerForJob(baseLog, job);
  const { userId, productId, strategicPathId, planId } = job.data;
  const traceId = getTraceId(job.data, job.id);
  const isFinalAttempt =
    job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

  jlog.info(
    `tactical-generate start user=${userId} planId=${planId} attempt=${job.attemptsMade + 1}/${job.opts.attempts ?? 1}`,
  );

  await publishUserEvent(userId, 'agents', {
    type: 'tactical_generate_started',
    planId,
    traceId,
  });
  await recordPipelineEvent({
    userId,
    productId,
    stage: 'launch_plan_started',
    metadata: { traceId, scope: 'tactical_generate', planId, attempt: job.attemptsMade + 1 },
  });

  try {
    const inputs = await buildPlannerInputs({
      userId,
      productId,
      strategicPathId,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PLAN_TIMEOUT_MS);

    let plan: TacticalPlan;
    try {
      const res = await Promise.race([
        runSkill<TacticalPlan>({
          skill: tacticalSkill,
          input: inputs.plannerInput,
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
    } finally {
      clearTimeout(timeoutId);
    }

    // Insert plan_items against the pre-existing plans row. If the
    // planner returned no items, there's nothing to write — surface it
    // as a zero-item completion event so the UI doesn't hang.
    let itemCount = 0;
    if (plan.items.length > 0) {
      await db.insert(planItems).values(
        plan.items.map((item) => ({
          userId,
          productId,
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
      itemCount = plan.items.length;
    }

    // Attach the planner's own notes to the plans row if present. The
    // commit route wrote notes=null; overwriting here is fine because
    // nothing else reads it between the header insert and now.
    if (plan.plan.notes) {
      await db
        .update(plans)
        .set({ notes: plan.plan.notes })
        .where(eq(plans.id, planId));
    }

    await publishUserEvent(userId, 'agents', {
      type: 'tactical_generate_completed',
      planId,
      itemCount,
      traceId,
    });
    await recordPipelineEvent({
      userId,
      productId,
      stage: 'launch_plan_completed',
      metadata: { traceId, scope: 'tactical_generate', planId, itemCount },
    });

    jlog.info(
      `tactical-generate done user=${userId} planId=${planId} items=${itemCount}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jlog.error(
      `tactical-generate failed user=${userId} planId=${planId}: ${message}`,
    );

    await recordPipelineEvent({
      userId,
      productId,
      stage: 'launch_plan_failed',
      metadata: {
        traceId,
        scope: 'tactical_generate',
        planId,
        error: message,
        attempt: job.attemptsMade + 1,
        final: isFinalAttempt,
      },
    });

    if (isFinalAttempt) {
      // Stamp the plans row so /today can render a helpful error state
      // instead of spinning.
      await db
        .update(plans)
        .set({
          notes: `tactical-generate failed after ${job.attemptsMade + 1} attempts: ${message}`,
        })
        .where(eq(plans.id, planId));

      await publishUserEvent(userId, 'agents', {
        type: 'tactical_generate_failed',
        planId,
        error: message,
        traceId,
      });
    }

    // Re-throw so BullMQ marks the attempt failed and applies backoff.
    throw err;
  }
}

interface PlannerInputs {
  plannerInput: Record<string, unknown>;
}

async function buildPlannerInputs(input: {
  userId: string;
  productId: string;
  strategicPathId: string;
}): Promise<PlannerInputs> {
  const { userId, productId, strategicPathId } = input;

  const [row] = await db
    .select({
      productName: products.name,
      productValueProp: products.valueProp,
      state: products.state,
      launchDate: products.launchDate,
      launchedAt: products.launchedAt,
      pathNarrative: strategicPaths.narrative,
      pathMilestones: strategicPaths.milestones,
      pathThesisArc: strategicPaths.thesisArc,
      pathContentPillars: strategicPaths.contentPillars,
      pathChannelMix: strategicPaths.channelMix,
      pathPhaseGoals: strategicPaths.phaseGoals,
    })
    .from(products)
    .innerJoin(strategicPaths, eq(strategicPaths.id, strategicPathId))
    .where(eq(products.id, productId))
    .limit(1);

  if (!row) {
    throw new Error(
      `tactical-generate: product/path not found (productId=${productId} strategicPathId=${strategicPathId})`,
    );
  }

  const state = row.state as ProductState;
  const currentPhase = derivePhase({
    state,
    launchDate: row.launchDate ?? null,
    launchedAt: row.launchedAt ?? null,
  });
  const { weekStart, weekEnd } = weekBounds(new Date());

  // Signals — same shape tactical-planner consumes elsewhere. Recent
  // milestones / metrics aren't loaded here (post-commit there's
  // nothing to load yet); stalled items and last-week completions
  // come from the existing plan_items table if any prior run exists.
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

  const channelMix = row.pathChannelMix as Record<string, unknown> | null;
  const connected = new Set(await getUserChannels(userId));
  const channels: Array<'x' | 'reddit' | 'email'> = [];
  if (channelMix) {
    for (const k of ['x', 'reddit', 'email'] as const) {
      if (!channelMix[k]) continue;
      if (k === 'email' || connected.has(k)) channels.push(k);
    }
  }
  if (channels.length === 0) {
    // If channelMix lists channels but the user disconnected them
    // between strategic and tactical, fall back to whatever they have
    // connected right now so the planner still produces something.
    for (const p of connected) {
      if (p === 'x' || p === 'reddit') channels.push(p);
    }
  }
  if (channels.length === 0) {
    throw new Error(
      'tactical-generate: no executable channels (user has neither channelMix nor connected channels)',
    );
  }

  const plannerInput: Record<string, unknown> = {
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
  };

  return { plannerInput };
}
