import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  products,
  strategicPaths,
  plans,
  planItems,
  channels,
  discoveryConfigs,
} from '@/lib/db/schema';
import {
  strategicPathSchema,
  tacticalPlanSchema,
} from '@/agents/schemas';
import { derivePhase } from '@/lib/launch-phase';
import { validateLaunchDates } from '@/lib/launch-date-rules';
import { acquireRateLimit } from '@/lib/rate-limit';
import { enqueueCalibration } from '@/lib/queue';
import { isPlatformAvailable } from '@/lib/platform-config';
import { deleteDraft } from '@/lib/onboarding-draft';
import { recordPipelineEvent } from '@/lib/pipeline-events';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:onboarding:commit');

// 1 commit per minute per user. Prevents accidental double-fire from
// racing UI buttons; an honest retry waits 60s.
const RATE_LIMIT_WINDOW_SECONDS = 60;

const productCategorySchema = z.enum([
  'dev_tool',
  'saas',
  'consumer',
  'creator_tool',
  'agency',
  'ai_app',
  'other',
]);

const requestBodySchema = z.object({
  product: z.object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    valueProp: z.string().max(600).nullable().optional(),
    keywords: z.array(z.string().min(1)).max(20),
    category: productCategorySchema,
    targetAudience: z.string().max(600).nullable().optional(),
    url: z.string().url().nullable().optional(),
  }),
  state: z.enum(['mvp', 'launching', 'launched']),
  launchDate: z.string().datetime().nullable().optional(),
  launchedAt: z.string().datetime().nullable().optional(),
  path: strategicPathSchema,
  plan: tacticalPlanSchema,
});

type RequestBody = z.infer<typeof requestBodySchema>;

/**
 * Detect whether the core product identity changed vs an existing row.
 * Triggers re-calibration of the discovery scorer. Compares
 * name / description / valueProp / keywords only — launch dates don't
 * invalidate discovery calibration.
 */
function coreFieldsChanged(
  prev: {
    name: string;
    description: string;
    valueProp: string | null;
    keywords: string[];
  } | null,
  next: RequestBody['product'],
): boolean {
  if (!prev) return true;
  if (prev.name !== next.name) return true;
  if (prev.description !== next.description) return true;
  if ((prev.valueProp ?? null) !== (next.valueProp ?? null)) return true;
  const prevKw = [...prev.keywords].sort().join('|');
  const nextKw = [...next.keywords].sort().join('|');
  return prevKw !== nextKw;
}

/**
 * POST /api/onboarding/commit
 *
 * Persists a previewed plan. Atomic: products upsert + strategic_paths
 * insert + plans insert + plan_items insert all run inside one
 * transaction. Calibration + draft cleanup fire AFTER the transaction
 * commits so their failures don't roll back the write.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const { log, traceId } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const rl = await acquireRateLimit(`commit:${userId}`, RATE_LIMIT_WINDOW_SECONDS);
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

  let body: RequestBody;
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

  const launchDate = body.launchDate ? new Date(body.launchDate) : null;
  const launchedAt = body.launchedAt ? new Date(body.launchedAt) : null;
  const currentPhase = derivePhase({ state: body.state, launchDate, launchedAt });

  const existing = await db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
      valueProp: products.valueProp,
      keywords: products.keywords,
    })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);
  const prev = existing[0] ?? null;

  const changed = coreFieldsChanged(prev, body.product);

  // --- transactional writes ---
  let productId: string;
  try {
    productId = await db.transaction(async (tx) => {
      // Upsert product. uniqueIndex products_user_uq(user_id) guarantees
      // one-per-user; we select + insert/update explicitly for clarity.
      let pid: string;
      if (prev) {
        await tx
          .update(products)
          .set({
            name: body.product.name,
            description: body.product.description,
            valueProp: body.product.valueProp ?? null,
            keywords: body.product.keywords,
            url: body.product.url ?? null,
            targetAudience: body.product.targetAudience ?? null,
            category: body.product.category,
            state: body.state,
            launchDate,
            launchedAt,
            onboardingCompletedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(products.id, prev.id));
        pid = prev.id;
      } else {
        const [row] = await tx
          .insert(products)
          .values({
            userId,
            name: body.product.name,
            description: body.product.description,
            valueProp: body.product.valueProp ?? null,
            keywords: body.product.keywords,
            url: body.product.url ?? null,
            targetAudience: body.product.targetAudience ?? null,
            category: body.product.category,
            state: body.state,
            launchDate,
            launchedAt,
            onboardingCompletedAt: new Date(),
          })
          .returning({ id: products.id });
        pid = row.id;
      }

      // Deactivate prior active path (if any) to honor the partial-uniq
      // strategic_paths_active_uq constraint.
      await tx
        .update(strategicPaths)
        .set({ isActive: false })
        .where(eq(strategicPaths.userId, userId));

      const [pathRow] = await tx
        .insert(strategicPaths)
        .values({
          userId,
          productId: pid,
          isActive: true,
          phase: currentPhase,
          launchDate,
          launchedAt,
          narrative: body.path.narrative,
          milestones: body.path.milestones,
          thesisArc: body.path.thesisArc,
          contentPillars: body.path.contentPillars,
          channelMix: body.path.channelMix,
          phaseGoals: body.path.phaseGoals,
        })
        .returning({ id: strategicPaths.id });
      const strategicPathId = pathRow.id;

      // plans header for this week
      const now = new Date();
      const weekStart = new Date(now);
      weekStart.setUTCHours(0, 0, 0, 0);
      const dayOffset = (weekStart.getUTCDay() + 6) % 7;
      weekStart.setUTCDate(weekStart.getUTCDate() - dayOffset);

      const [planRow] = await tx
        .insert(plans)
        .values({
          userId,
          productId: pid,
          strategicPathId,
          trigger: 'onboarding',
          weekStart,
          notes: body.plan.plan.notes,
        })
        .returning({ id: plans.id });
      const planId = planRow.id;

      // plan_items rows
      if (body.plan.items.length > 0) {
        await tx.insert(planItems).values(
          body.plan.items.map((item) => ({
            userId,
            productId: pid,
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
      }

      return pid;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`commit tx failed user=${userId}: ${message}`);
    return NextResponse.json(
      { error: 'commit_failed', detail: message },
      { status: 500, headers: { 'x-trace-id': traceId } },
    );
  }

  // --- post-transaction side effects (best-effort, never block response) ---

  const enqueued: string[] = [];

  if (changed) {
    try {
      const userChannels = await db
        .select({ platform: channels.platform })
        .from(channels)
        .where(eq(channels.userId, userId));
      const platforms = [...new Set(userChannels.map((c) => c.platform))].filter(
        isPlatformAvailable,
      );

      for (const platform of platforms) {
        await db
          .insert(discoveryConfigs)
          .values({
            userId,
            platform,
            calibrationStatus: 'pending',
          })
          .onConflictDoUpdate({
            target: [discoveryConfigs.userId, discoveryConfigs.platform],
            set: {
              calibrationStatus: 'pending',
              calibrationRound: 0,
              calibrationPrecision: null,
              calibrationLog: null,
              updatedAt: new Date(),
            },
          });
      }

      if (platforms.length > 0) {
        await enqueueCalibration({ userId, productId });
        for (const p of platforms) enqueued.push(`calibration:${p}`);
      }
    } catch (err) {
      log.warn(
        `post-commit calibration enqueue failed user=${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Clear Redis draft; errors here are non-fatal.
  try {
    await deleteDraft(userId);
  } catch (err) {
    log.warn(
      `post-commit draft clear failed user=${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await recordPipelineEvent({
    userId,
    productId,
    stage: 'launch_plan_completed',
    metadata: {
      traceId,
      kind: 'commit',
      items: body.plan.items.length,
      calibrated: enqueued.length > 0,
    },
  });

  log.info(
    `commit done user=${userId} product=${productId} items=${body.plan.items.length} enqueued=${enqueued.length}`,
  );

  return NextResponse.json(
    { success: true, productId, enqueued },
    { headers: { 'x-trace-id': traceId } },
  );
}
