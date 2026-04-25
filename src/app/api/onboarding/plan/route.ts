import { type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import type { StrategicPath } from '@/tools/schemas';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { derivePhase } from '@/lib/launch-phase';
import { acquireRateLimit } from '@/lib/rate-limit';
import { recordPipelineEvent } from '@/lib/pipeline-events';
import { createLogger, loggerForRequest } from '@/lib/logger';
import { ensureTeamExists } from '@/lib/team-provisioner';
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { createAutomationConversation } from '@/lib/team-conversation-helpers';
import { subscribeToStrategicPathEvents } from '@/lib/onboarding-team-run';

const baseLog = createLogger('api:onboarding:plan');

// 180 second ceiling. Strategic-planner alone runs ~30–40s on a good day;
// the ceiling is the slow-Anthropic-API fallback. Tactical-planner no
// longer runs here — it's enqueued post-commit as a background job.
const PLAN_TIMEOUT_MS = 180_000;

// Heartbeat every 15s so intermediate proxies (Vercel/CF) don't reap the
// connection as idle while strategic-planner is mid-turn.
const HEARTBEAT_INTERVAL_MS = 15_000;

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

function jsonError(status: number, body: Record<string, unknown>, traceId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'x-trace-id': traceId,
    },
  });
}

/**
 * POST /api/onboarding/plan
 *
 * Streams strategic-planner output over SSE. Emits exactly one terminal
 * event (`strategic_done` on success, `error` on failure) and closes. The
 * tactical-planner no longer runs here — it's enqueued post-commit from
 * `/api/onboarding/commit` as a background `tactical-generate` job so Stage 6
 * advances in ~30s instead of the previous 60–90s.
 *
 * Pre-stream responses (still JSON):
 *   401 — unauthorized
 *   400 — invalid request body
 *   429 — rate-limited
 *
 * Stream (200, text/event-stream) events:
 *   data: { "type": "heartbeat" }
 *   data: { "type": "strategic_done", "path": StrategicPath }
 *   data: { "type": "error", "error": string }
 */
export async function POST(request: NextRequest): Promise<Response> {
  const { log, traceId } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return jsonError(401, { error: 'Unauthorized' }, traceId);
  }
  const userId = session.user.id;

  const rl = await acquireRateLimit(`plan:${userId}`, RATE_LIMIT_WINDOW_SECONDS);
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({
        error: 'rate_limited',
        retryAfterSeconds: rl.retryAfterSeconds,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
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
    return jsonError(400, { error: 'invalid_request', detail: message }, traceId);
  }

  const launchDate = body.launchDate ? new Date(body.launchDate) : null;
  const launchedAt = body.launchedAt ? new Date(body.launchedAt) : null;
  const currentPhase = derivePhase({ state: body.state, launchDate, launchedAt });

  log.info(
    `strategic plan SSE start user=${userId} state=${body.state} phase=${currentPhase} channels=[${body.channels.join(',')}]`,
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const enqueue = (payload: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // stream already closed by client abort
        }
      };

      const heartbeat = setInterval(
        () => enqueue({ type: 'heartbeat' }),
        HEARTBEAT_INTERVAL_MS,
      );

      const abortController = new AbortController();
      const timeoutId = setTimeout(
        () => abortController.abort(),
        PLAN_TIMEOUT_MS,
      );

      const cleanup = (finalEvent: Record<string, unknown>) => {
        if (closed) return;
        // Emit the terminal event BEFORE flipping `closed`, otherwise
        // `enqueue` short-circuits and we lose the final frame.
        enqueue(finalEvent);
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(timeoutId);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      try {
        // Phase C: team-run is the only path. When the user hasn't
        // committed a product row yet (fresh onboarding), pass
        // productId=null — ensureTeamExists accepts that and creates a
        // product-less team. The commit route later binds the team
        // to the real productId via its own upsert.
        const existingProduct = await db
          .select({ id: products.id })
          .from(products)
          .where(eq(products.userId, userId))
          .limit(1);

        const path: StrategicPath = await runViaTeamRun({
          userId,
          productId: existingProduct[0]?.id ?? null,
          body,
          currentPhase,
          abortSignal: abortController.signal,
          onHeartbeat: () => enqueue({ type: 'heartbeat' }),
        });

        await recordPipelineEvent({
          userId,
          stage: 'launch_plan_completed',
          metadata: {
            traceId,
            pillars: path.contentPillars.length,
            thesisWeeks: path.thesisArc.length,
            scope: 'strategic_only',
            runner: 'team_run',
          },
        });

        log.info(
          `strategic plan done user=${userId} pillars=${path.contentPillars.length} runner=team_run`,
        );

        cleanup({ type: 'strategic_done', path });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Surface the underlying pg/driver cause — Drizzle wraps driver
        // errors so `.message` is just "Failed query: <SQL>" and the real
        // detail lives on `.cause` (e.g. 'relation "teams" does not exist
        // [42P01]' when a migration hasn't been applied).
        const cause =
          err instanceof Error && err.cause
            ? err.cause instanceof Error
              ? `${err.cause.message}${(err.cause as { code?: string }).code ? ` [${(err.cause as { code?: string }).code}]` : ''}`
              : String(err.cause)
            : undefined;
        const fullMessage = cause ? `${message} — cause: ${cause}` : message;
        await recordPipelineEvent({
          userId,
          stage: 'launch_plan_failed',
          metadata: { traceId, error: fullMessage },
        });

        if (err instanceof PlannerTimeoutError) {
          log.error(
            `strategic plan timeout user=${userId} after ${PLAN_TIMEOUT_MS}ms`,
          );
          cleanup({ type: 'error', error: 'planner_timeout' });
          return;
        }

        log.error(`strategic plan failed user=${userId}: ${fullMessage}`);
        cleanup({ type: 'error', error: message });
      }
    },
    cancel() {
      // Client aborted; the runStrategic promise will settle on its own.
      // Nothing actionable here — cleanup already ran or will shortly.
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'x-trace-id': traceId,
    },
  });
}

class PlannerTimeoutError extends Error {
  constructor() {
    super('planner_timeout');
    this.name = 'PlannerTimeoutError';
  }
}

interface RunViaTeamRunArgs {
  userId: string;
  /**
   * Null on fresh onboarding (user hasn't called /api/onboarding/commit
   * yet). ensureTeamExists accepts null and creates a product-less team;
   * the commit route later binds it to the real productId via upsert.
   */
  productId: string | null;
  body: RequestBody;
  currentPhase: ReturnType<typeof derivePhase>;
  abortSignal: AbortSignal;
  onHeartbeat?: () => void;
}

async function runViaTeamRun(
  args: RunViaTeamRunArgs,
): Promise<StrategicPath> {
  const { userId, productId, body, currentPhase, abortSignal } = args;

  // 1) Ensure a team + base roster exists for this (userId, productId).
  const { teamId, memberIds } = await ensureTeamExists(userId, productId);

  // 2) Enqueue the team-run rooted at growth-strategist.
  //
  //    Pre-Phase-F we rooted onboarding at the coordinator so it could
  //    delegate, but the coordinator kept making bad parallel-spawn
  //    decisions (spawning content-planner + a writer before the
  //    strategic_path existed → the writer hallucinated plan_item IDs →
  //    wasted 15s + retries). Since onboarding is a single-responsibility
  //    flow ("write the strategic path"), we skip the delegation turn
  //    and root the run directly at growth-strategist. Content-planner
  //    runs as a separate team_run from /api/onboarding/commit after
  //    the founder reviews the path.
  //
  //    Net effect: ~30-50s faster per onboarding, no coordinator Sonnet
  //    turn, no parallel-spawn foot-guns.
  const milestoneNote =
    body.recentMilestones && body.recentMilestones.length > 0
      ? ` Recent shipping: ${body.recentMilestones.map((m) => m.title).join('; ')}.`
      : '';
  const launchDateNote = body.launchDate
    ? ` Launch date: ${body.launchDate.slice(0, 10)}.`
    : body.launchedAt
      ? ` Launched: ${body.launchedAt.slice(0, 10)}.`
      : '';
  // Growth-strategist-specific goal: tell it directly to call
  // write_strategic_path, not the generic "plan the launch" goal which
  // the model can misread as "return a description".
  //
  // We pass `today` and `weekStart` (Monday 00:00 UTC of the ISO week
  // containing today) so the LLM doesn't have to infer the calendar
  // anchor — `thesisArc[0].weekStart` MUST equal this value, even when
  // onboarding fires on a Saturday or Sunday. Anchoring to current week
  // (vs. next Monday) means the founder sees plan items for the current
  // week immediately rather than a 1-7 day empty window.
  const { currentWeekStart } = await import('@/lib/week-bounds');
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const week1Start = currentWeekStart(now).toISOString().slice(0, 10);
  const goal =
    `Write the 30-day strategic path for ${body.product.name} by calling ` +
    `write_strategic_path. ` +
    `Today (UTC): ${todayIso}. ` +
    `thesisArc[0].weekStart MUST equal ${week1Start} (Monday of the ISO ` +
    `week containing today — NOT next Monday). Subsequent thesisArc entries ` +
    `are consecutive Mondays after that. ` +
    `Category: ${body.product.category}. ` +
    `State: ${body.state}. Phase: ${currentPhase}. ` +
    `Channels: ${body.channels.join(', ')}.` +
    launchDateNote +
    milestoneNote +
    ` Follow your strategic-path-playbook (six ordered steps) and persist ` +
    `via the write_strategic_path tool. Do not emit the terminal ` +
    `StructuredOutput until write_strategic_path has succeeded.`;

  const conversationId = await createAutomationConversation(teamId, 'onboarding');
  const { runId } = await enqueueTeamRun({
    teamId,
    trigger: 'onboarding',
    goal,
    rootMemberId: memberIds['growth-strategist'],
    conversationId,
  });

  // 3) Subscribe to the team's Redis channel, translate events to the
  //    onboarding UI's event shape, and return the first strategic_done.
  const generator = subscribeToStrategicPathEvents(teamId, runId, {
    timeoutMs: PLAN_TIMEOUT_MS,
  });

  try {
    for await (const event of generator) {
      if (abortSignal.aborted) {
        throw new PlannerTimeoutError();
      }
      if (event.type === 'heartbeat') {
        args.onHeartbeat?.();
        continue;
      }
      if (event.type === 'error') {
        throw new Error(event.error);
      }
      if (event.type === 'strategic_done') {
        return event.path;
      }
    }
  } finally {
    try {
      await generator.return();
    } catch {
      // Generator already completed.
    }
  }

  throw new Error('team-run ended without a strategic path');
}
