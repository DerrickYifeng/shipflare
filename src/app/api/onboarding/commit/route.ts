import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  products,
  strategicPaths,
  plans,
} from '@/lib/db/schema';
import { strategicPathSchema } from '@/tools/schemas';
import { derivePhase } from '@/lib/launch-phase';
import { validateLaunchDates } from '@/lib/launch-date-rules';
import { acquireRateLimit } from '@/lib/rate-limit';
import { deleteDraft } from '@/lib/onboarding-draft';
import { recordPipelineEvent } from '@/lib/pipeline-events';
import { createLogger, loggerForRequest } from '@/lib/logger';
import { provisionTeamForProduct } from '@/lib/team-provisioner';

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

// Stage-5 launch context. Accepted so the frontend can send them without
// Zod stripping; persisted only on the pipeline event for observability
// until strategic_paths grows a dedicated column. Matches the shape used
// by POST /api/onboarding/plan.
const launchChannelSchema = z.enum(['producthunt', 'showhn', 'both', 'other']);
const usersBucketSchema = z.enum(['<100', '100-1k', '1k-10k', '10k+']);

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
  launchChannel: launchChannelSchema.nullable().optional(),
  usersBucket: usersBucketSchema.nullable().optional(),
  path: strategicPathSchema,
  // Phase E Day 3: `plan` inline-insert back-compat is gone. plan_items
  // are populated exclusively by the onboarding team-run already in
  // flight from POST /api/onboarding/plan (content-planner writes them
  // via add_plan_item). Clients that still send `plan` get it silently
  // dropped by the zod strict flag below.
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
  let strategicPathId: string;
  let planId: string;
  try {
    const txResult = await db.transaction(async (tx) => {
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
      const spid = pathRow.id;

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
          strategicPathId: spid,
          trigger: 'onboarding',
          weekStart,
          // `notes` starts null — the onboarding team-run's content-
          // planner fills it in (or leaves it null if nothing to say).
          notes: null,
        })
        .returning({ id: plans.id });
      const pid2 = planRow.id;

      // Phase E Day 3: no inline plan_items insert. The onboarding team-
      // run writes plan_items asynchronously via add_plan_item.

      return { productId: pid, strategicPathId: spid, planId: pid2 };
    });
    productId = txResult.productId;
    strategicPathId = txResult.strategicPathId;
    planId = txResult.planId;
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

  // Phase F: reconcile the team roster now that the product is committed
  // (we have the final category + connected channels). Idempotent — if a
  // baseline team was seeded by POST /api/onboarding/plan earlier in the
  // flow, this adds the preset's writer/community members on top.
  try {
    const provision = await provisionTeamForProduct(userId, productId);
    log.info(
      `provisionTeamForProduct: team=${provision.teamId} preset=${provision.preset} roster=[${provision.roster.join(',')}] created=${provision.created}`,
    );
  } catch (err) {
    log.warn(
      `provisionTeamForProduct failed (non-fatal) user=${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Kickoff is now triggered on the user's first visit to /team — see
  // `ensureKickoffEnqueued` in src/lib/team-kickoff.ts. Firing it here
  // would spin up the AI team while the user is still on the onboarding
  // "thanks!" screen, so they'd land on /team and find a half-done
  // dispatch instead of a live one. Returning a null conversationId is
  // safe: the team page selects its latest conversation on load, which
  // becomes the kickoff conversation as soon as ensureKickoffEnqueued
  // creates it.

  // Discovery v3: no calibration. The first discovery-scan for this
  // product generates the onboarding rubric lazily. If the product
  // context changed, clear the cached rubric so the next scan rebuilds
  // it against the latest fields.
  if (changed) {
    try {
      const { MemoryStore } = await import('@/memory/store');
      const { ONBOARDING_RUBRIC_MEMORY_NAME } = await import(
        '@/lib/discovery/onboarding-rubric'
      );
      const store = new MemoryStore(userId, productId);
      await store.removeEntry(ONBOARDING_RUBRIC_MEMORY_NAME);
    } catch (err) {
      log.warn(
        `post-commit rubric clear failed user=${userId}: ${err instanceof Error ? err.message : String(err)}`,
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
      items: 0,
      planId,
      strategicPathId,
      calibrated: changed && enqueued.some((e) => e.startsWith('calibration:')),
      // Launch-context hints from Stage 5. Persisted on the event rather
      // than the strategic_paths row so we don't ship a migration for
      // a metric we're not yet consuming server-side. Use these to
      // retrospect "do Product Hunt launchers get better plans than
      // Show HN launchers?" once there's enough traffic.
      launchChannel: body.launchChannel ?? null,
      usersBucket: body.usersBucket ?? null,
    },
  });

  log.info(
    `commit done user=${userId} product=${productId} planId=${planId} enqueued=${enqueued.length} launchChannel=${body.launchChannel ?? '-'} usersBucket=${body.usersBucket ?? '-'}`,
  );

  return NextResponse.json(
    {
      success: true,
      productId,
      conversationId: null,
      enqueued,
    },
    { headers: { 'x-trace-id': traceId } },
  );
}
