import { NextResponse, type NextRequest } from 'next/server';
import { join } from 'node:path';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { SKILL_CATALOG } from '@/skills/_catalog';
import {
  strategicPathSchema,
  tacticalPlanSchema,
  type StrategicPath,
  type TacticalPlan,
} from '@/agents/schemas';
import { derivePhase } from '@/lib/launch-phase';
import { acquireRateLimit } from '@/lib/rate-limit';
import { recordPipelineEvent } from '@/lib/pipeline-events';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:onboarding:plan');

// 45 second budget for the full strategic → tactical chain. Sonnet 4.6
// + Haiku 4.5 together typically finishes in 8-15s; 45s leaves headroom
// for the Anthropic API adding a long-tail spike.
const PLAN_TIMEOUT_MS = 45_000;

// One plan generation per 10 seconds per user. Prevents the founder
// mashing "Generate plan" from burning 3x the cost in 30s.
const RATE_LIMIT_WINDOW_SECONDS = 10;

const productCategorySchema = z.enum([
  'dev_tool',
  'saas',
  'consumer',
  'creator_tool',
  'agency',
  'ai_app',
  'other',
]);

const productStateSchema = z.enum(['mvp', 'launching', 'launched']);

// Stage-5 launch context. `launchChannel` is meaningful only for
// state='launching' (where is this founder launching?); `usersBucket`
// only for state='launched' (how big is the audience now?). Allow both
// on every state because the onboarding flow already clamps nulls at
// the UI layer — server just needs to accept + forward them.
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
  }),
  channels: z.array(z.enum(['x', 'reddit', 'email'])).min(1),
  state: productStateSchema,
  launchDate: z.string().datetime().nullable().optional(),
  launchedAt: z.string().datetime().nullable().optional(),
  launchChannel: launchChannelSchema.nullable().optional(),
  usersBucket: usersBucketSchema.nullable().optional(),
  recentMilestones: z
    .array(
      z.object({
        title: z.string().min(1),
        summary: z.string().min(1),
        source: z.enum(['commit', 'pr', 'release']),
        atISO: z.string().min(1),
      }),
    )
    .optional(),
  voiceProfile: z.string().nullable().optional(),
});

type RequestBody = z.infer<typeof requestBodySchema>;

/**
 * Pre-load skills at module init. Same pattern as reply-hardening.ts
 * — the load is a file-system read that never changes at runtime.
 */
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

function weekBounds(now: Date): { weekStart: Date; weekEnd: Date } {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  const weekStart = new Date(d);
  const weekEnd = new Date(d);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  return { weekStart, weekEnd };
}

/**
 * POST /api/onboarding/plan
 *
 * Runs strategic-planner → tactical-planner back-to-back to produce a
 * `{ path, plan }` pair the caller can preview before committing with
 * `POST /api/onboarding/commit`. Stateless — no DB writes. Redis draft
 * is untouched.
 *
 * Response codes:
 *   200 — `{ path, plan }` returned
 *   400 — invalid request body
 *   401 — unauthorized
 *   429 — rate-limited (`Retry-After` header set)
 *   504 — planner timed out
 *   500 — planner error (schema mismatch, LLM 5xx, etc.)
 */
export async function POST(request: NextRequest): Promise<Response> {
  const { log, traceId } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const rl = await acquireRateLimit(`plan:${userId}`, RATE_LIMIT_WINDOW_SECONDS);
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

  const launchDate = body.launchDate ? new Date(body.launchDate) : null;
  const launchedAt = body.launchedAt ? new Date(body.launchedAt) : null;
  const currentPhase = derivePhase({ state: body.state, launchDate, launchedAt });

  log.info(
    `planner chain start user=${userId} state=${body.state} phase=${currentPhase} channels=[${body.channels.join(',')}]`,
  );

  await recordPipelineEvent({
    userId,
    stage: 'launch_plan_started',
    metadata: {
      traceId,
      state: body.state,
      currentPhase,
      channels: body.channels,
      launchChannel: body.launchChannel ?? null,
      usersBucket: body.usersBucket ?? null,
    },
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PLAN_TIMEOUT_MS);

  try {
    const { path, plan } = await Promise.race([
      runChain(body, currentPhase, userId),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(new PlannerTimeoutError()),
        );
      }),
    ]);

    clearTimeout(timeoutId);

    await recordPipelineEvent({
      userId,
      stage: 'launch_plan_completed',
      metadata: {
        traceId,
        pillars: path.contentPillars.length,
        thesisWeeks: path.thesisArc.length,
        items: plan.items.length,
      },
    });

    log.info(
      `planner chain done user=${userId} pillars=${path.contentPillars.length} items=${plan.items.length}`,
    );

    return NextResponse.json(
      { path, plan },
      { headers: { 'x-trace-id': traceId } },
    );
  } catch (err) {
    clearTimeout(timeoutId);

    const message = err instanceof Error ? err.message : String(err);
    await recordPipelineEvent({
      userId,
      stage: 'launch_plan_failed',
      metadata: { traceId, error: message },
    });

    if (err instanceof PlannerTimeoutError) {
      log.error(`planner chain timeout user=${userId} after ${PLAN_TIMEOUT_MS}ms`);
      return NextResponse.json(
        { error: 'planner_timeout' },
        { status: 504, headers: { 'x-trace-id': traceId } },
      );
    }

    log.error(`planner chain failed user=${userId}: ${message}`);
    return NextResponse.json(
      { error: 'planner_failed', detail: message },
      { status: 500, headers: { 'x-trace-id': traceId } },
    );
  }
}

class PlannerTimeoutError extends Error {
  constructor() {
    super('planner_timeout');
    this.name = 'PlannerTimeoutError';
  }
}

async function runChain(
  body: RequestBody,
  currentPhase: ReturnType<typeof derivePhase>,
  userId: string,
): Promise<{ path: StrategicPath; plan: TacticalPlan }> {
  // Launch context hints from Stage 5. Only forward fields the state
  // actually uses so the planner prompt stays focused (launchChannel
  // for 'launching', usersBucket for 'launched'). Omitted entirely when
  // null — the skill prompt treats missing keys as "unknown".
  const launchContext: {
    launchChannel?: z.infer<typeof launchChannelSchema>;
    usersBucket?: z.infer<typeof usersBucketSchema>;
  } = {};
  if (body.state === 'launching' && body.launchChannel) {
    launchContext.launchChannel = body.launchChannel;
  }
  if (body.state === 'launched' && body.usersBucket) {
    launchContext.usersBucket = body.usersBucket;
  }

  // Strategic pass
  const strategicRes = await runSkill<StrategicPath>({
    skill: strategicSkill,
    input: {
      product: body.product,
      state: body.state,
      currentPhase,
      launchDate: body.launchDate ?? null,
      launchedAt: body.launchedAt ?? null,
      channels: body.channels,
      voiceProfile: body.voiceProfile ?? null,
      recentMilestones: body.recentMilestones ?? [],
      launchContext,
    },
    outputSchema: strategicPathSchema,
  });

  if (strategicRes.errors.length > 0) {
    throw new Error(
      `strategic-planner error: ${strategicRes.errors.map((e) => e.error).join('; ')}`,
    );
  }
  const path = strategicRes.results[0];
  if (!path) {
    throw new Error('strategic-planner returned no result');
  }

  // Tactical pass
  const { weekStart, weekEnd } = weekBounds(new Date());
  const tacticalRes = await runSkill<TacticalPlan>({
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
        name: body.product.name,
        valueProp: body.product.valueProp ?? null,
        currentPhase,
        state: body.state,
        launchDate: body.launchDate ?? null,
        launchedAt: body.launchedAt ?? null,
      },
      launchContext,
      channels: body.channels,
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      signals: {
        recentMilestones: body.recentMilestones ?? [],
        recentMetrics: [],
        stalledItems: [],
        completedLastWeek: [],
        currentLaunchTasks: [],
      },
      skillCatalog: catalogProjection,
      voiceBlock: body.voiceProfile ?? null,
    },
    outputSchema: tacticalPlanSchema,
  });

  if (tacticalRes.errors.length > 0) {
    throw new Error(
      `tactical-planner error: ${tacticalRes.errors.map((e) => e.error).join('; ')}`,
    );
  }
  const plan = tacticalRes.results[0];
  if (!plan) {
    throw new Error('tactical-planner returned no result');
  }

  void userId; // kept for future per-user skill dep injection.
  return { path, plan };
}
