import { type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import type { StrategicPath } from '@/tools/schemas';
import { strategicPathSchema } from '@/tools/schemas';
import { db } from '@/lib/db';
import { products, strategicPaths } from '@/lib/db/schema';
import { derivePhase } from '@/lib/launch-phase';
import { acquireRateLimit } from '@/lib/rate-limit';
import { recordPipelineEvent } from '@/lib/pipeline-events';
import { createLogger, loggerForRequest } from '@/lib/logger';
import { runForkSkill } from '@/skills/run-fork-skill';
import {
  generatingStrategyOutputSchema,
  type GeneratingStrategyOutput,
} from '@/skills/generating-strategy/schema';
import type { StreamEvent } from '@/core/types';

const baseLog = createLogger('api:onboarding:plan');

// 180 second ceiling. The generating-strategy skill alone runs ~20–30s on a
// good day; the ceiling is the slow-Anthropic-API fallback. Tactical-planner
// no longer runs here — it's enqueued post-commit as a background job.
const PLAN_TIMEOUT_MS = 180_000;

// Heartbeat every 15s so intermediate proxies (Vercel/CF) don't reap the
// connection as idle while the skill is mid-turn.
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
 * Streams the strategic-path generation directly via the
 * `generating-strategy` fork-mode skill — NO team-run row, NO coordinator
 * agent. Skill tool events (`tool_start` / `tool_done`) are translated
 * inline into `tool_progress` SSE frames so the UI can light up per-tool
 * step labels (query → write → done) as the skill runs.
 *
 * SSE channel naming: events are emitted on the route's own response
 * stream (per-request, not via Redis pub/sub). The route's `traceId` is
 * the conceptual channel id — every event on this stream belongs to one
 * onboarding plan invocation and the consumer is the same client that
 * issued the POST. This avoids the cross-process Redis hop the previous
 * team-run-routed implementation needed.
 *
 * Pre-stream responses (still JSON):
 *   401 — unauthorized
 *   400 — invalid request body
 *   429 — rate-limited
 *
 * Stream (200, text/event-stream) events:
 *   data: { "type": "heartbeat" }
 *   data: { "type": "tool_progress", "phase": "start"|"done"|"error",
 *           "toolName": string, "toolUseId": string,
 *           "durationMs"?: number, "errorMessage"?: string }
 *   data: { "type": "strategic_done", "path": StrategicPath }
 *   data: { "type": "error", "error": string }
 *
 * The existing UI consumes only `strategic_done` / `error` / `heartbeat`,
 * so `tool_progress` is additive — current callers ignore unknown types.
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

  // Lifted to outer closure so cancel() can release these on client abort.
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const abortController = new AbortController();

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (payload: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // stream already closed by client abort
        }
      };

      heartbeat = setInterval(
        () => enqueue({ type: 'heartbeat' }),
        HEARTBEAT_INTERVAL_MS,
      );

      timeoutId = setTimeout(
        () => abortController.abort(),
        PLAN_TIMEOUT_MS,
      );

      const cleanup = (finalEvent: Record<string, unknown>) => {
        if (closed) return;
        // Emit the terminal event BEFORE flipping `closed`, otherwise
        // `enqueue` short-circuits and we lose the final frame.
        enqueue(finalEvent);
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (timeoutId) clearTimeout(timeoutId);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      try {
        // The skill's `write_strategic_path` tool requires a real
        // products.id (FK + notNull on strategic_paths.product_id).
        // Resolve an existing row if there is one; otherwise INSERT a
        // fresh row using the body fields the route already has. The
        // commit route's upsert block (commit/route.ts:175-213, both
        // the UPDATE and INSERT arms) refines whatever lands here when
        // the user clicks through stage-plan.
        const existingProduct = await db
          .select({ id: products.id })
          .from(products)
          .where(eq(products.userId, userId))
          .limit(1);

        let productId: string;
        if (existingProduct[0]) {
          productId = existingProduct[0].id;
        } else {
          // onboardingCompletedAt stays null until /commit; the commit
          // route stamps it when the user finalizes. launchDate /
          // launchedAt are reused from the top-of-handler normalization
          // (see line 157) so the INSERT shape stays in sync with the
          // rest of the handler — single source of truth for the coercion.
          const inserted = await db
            .insert(products)
            .values({
              userId,
              name: body.product.name,
              description: body.product.description,
              valueProp: body.product.valueProp ?? null,
              keywords: body.product.keywords,
              targetAudience: body.product.targetAudience ?? null,
              category: body.product.category,
              state: body.state,
              launchDate,
              launchedAt,
            })
            .onConflictDoNothing({ target: products.userId })
            .returning({ id: products.id });

          if (inserted[0]) {
            productId = inserted[0].id;
          } else {
            // Concurrent INSERT race — another tx won; re-select the
            // row that's now there. uniqueIndex products_user_uq
            // guarantees exactly one row per user, so a re-select
            // returns the racing transaction's id.
            const refetch = await db
              .select({ id: products.id })
              .from(products)
              .where(eq(products.userId, userId))
              .limit(1);
            if (!refetch[0]) {
              // Theoretically unreachable: PG READ COMMITTED + the
              // products_user_uq unique index means the racing tx's
              // row is committed-and-visible by the time
              // onConflictDoNothing returns []. If we ever hit this
              // branch it indicates a driver-level invariant break
              // (or REPEATABLE READ leaking into the pool). Log loud
              // with userId + traceId so an oncall can triage, then
              // throw a stable code an alert can grep / page on.
              log.error(
                `onboarding/plan: race-loss re-select returned no row for user=${userId} traceId=${traceId} — products_user_uq invariant broken`,
              );
              throw new Error('PRODUCTS_RACE_REFETCH_MISS');
            }
            productId = refetch[0].id;
          }
        }

        const path: StrategicPath = await runStrategicPathSkill({
          userId,
          productId,
          body,
          currentPhase,
          abortSignal: abortController.signal,
          onToolEvent: (event) => enqueue(event as unknown as Record<string, unknown>),
        });

        await recordPipelineEvent({
          userId,
          stage: 'launch_plan_completed',
          metadata: {
            traceId,
            pillars: path.contentPillars.length,
            thesisWeeks: path.thesisArc.length,
            scope: 'strategic_only',
            runner: 'direct_skill',
          },
        });

        log.info(
          `strategic plan done user=${userId} pillars=${path.contentPillars.length} runner=direct_skill`,
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
      // Client aborted (tab closed, navigation, etc.). Release resources
      // so the inner skill invocation stops consuming Anthropic tokens
      // and the heartbeat timer doesn't fire on a dead controller.
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (timeoutId) clearTimeout(timeoutId);
      abortController.abort();
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

/* ------------------------------------------------------------------------ */
/* Tool-progress event shape                                                */
/* ------------------------------------------------------------------------ */

/**
 * Per-tool progress event surfaced on the SSE stream. Mirrors the shape
 * the future onboarding step UI consumes — `phase` distinguishes the
 * lifecycle moment, `toolUseId` lets the UI dedupe across reconnects.
 *
 * `start` lands when the skill's agent emits a `tool_use` block;
 * `done` lands when the tool returns (with `durationMs`); `error` lands
 * when the tool itself throws (rather than returning is_error=true,
 * which the agent loop handles internally as a recoverable retry).
 */
export interface ToolProgressEvent {
  type: 'tool_progress';
  phase: 'start' | 'done' | 'error';
  toolName: string;
  toolUseId: string;
  durationMs?: number;
  errorMessage?: string;
}

/* ------------------------------------------------------------------------ */
/* Direct skill invocation                                                  */
/* ------------------------------------------------------------------------ */

interface RunStrategicPathSkillArgs {
  userId: string;
  /**
   * Real products.id — the route resolves-or-inserts before invoking
   * the skill so `write_strategic_path` always has a valid FK target.
   * The commit route later refines the row via its upsert path.
   */
  productId: string;
  body: RequestBody;
  currentPhase: ReturnType<typeof derivePhase>;
  abortSignal: AbortSignal;
  /** Called for every tool_progress event the route should forward to the SSE stream. */
  onToolEvent: (event: ToolProgressEvent) => void;
}

/**
 * Translate a runAgent StreamEvent into a `tool_progress` SSE frame.
 * Returns null for events the onboarding stream doesn't surface
 * (turn_start / text_delta / etc.) so the route doesn't leak internal
 * agent-loop chatter into the UI.
 */
function streamEventToProgress(event: StreamEvent): ToolProgressEvent | null {
  if (event.type === 'tool_start') {
    return {
      type: 'tool_progress',
      phase: 'start',
      toolName: event.toolName,
      toolUseId: event.toolUseId,
    };
  }
  if (event.type === 'tool_done') {
    const isError = event.result?.is_error === true;
    return {
      type: 'tool_progress',
      phase: isError ? 'error' : 'done',
      toolName: event.toolName,
      toolUseId: event.toolUseId,
      durationMs: event.durationMs,
      ...(isError
        ? {
            errorMessage:
              typeof event.result?.content === 'string'
                ? event.result.content.slice(0, 500)
                : undefined,
          }
        : {}),
    };
  }
  return null;
}

/**
 * Build the skill's input payload from the route request body and run
 * the `generating-strategy` fork skill directly. Returns the persisted
 * StrategicPath (loaded back from `strategic_paths` by `pathId` so the
 * SSE consumer gets a canonical-from-storage payload).
 */
async function runStrategicPathSkill(
  args: RunStrategicPathSkillArgs,
): Promise<StrategicPath> {
  const { userId, productId, body, currentPhase, abortSignal, onToolEvent } =
    args;

  // Calendar anchor — `thesisArc[0].weekStart` MUST equal Monday 00:00 UTC
  // of the ISO week containing today, even when onboarding fires on a
  // weekend. Pre-computed here so the LLM doesn't have to derive it.
  const { currentWeekStart } = await import('@/lib/week-bounds');
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const week1Start = currentWeekStart(now).toISOString().slice(0, 10);

  const skillInput = {
    product: {
      name: body.product.name,
      description: body.product.description,
      category: body.product.category,
      valueProp: body.product.valueProp ?? null,
      targetAudience: body.product.targetAudience ?? null,
      keywords: body.product.keywords,
    },
    state: body.state,
    currentPhase,
    channels: body.channels,
    launchDate: body.launchDate ?? null,
    launchedAt: body.launchedAt ?? null,
    recentMilestones: body.recentMilestones ?? [],
    today: todayIso,
    weekStart: week1Start,
  };

  // Forward parent abort into the skill's child agent so a client cancel
  // cascades through the runAgent loop. The deps record carries everything
  // the skill's tools need (write_strategic_path, query_recent_milestones,
  // query_strategic_path) plus an `onEvent` hook that runForkSkill reads
  // off the synthesized ToolContext.
  const aborted = (): boolean => abortSignal.aborted;

  const onEvent = (event: StreamEvent): void => {
    if (aborted()) return;
    const progress = streamEventToProgress(event);
    if (progress) {
      try {
        onToolEvent(progress);
      } catch {
        // UI decoration only — never crash the agent loop on a stream
        // controller hiccup.
      }
    }
  };

  const deps: Record<string, unknown> = {
    userId,
    productId,
    db,
    onEvent,
  };

  // runForkSkill: when given a deps record (no parent ToolContext), it
  // synthesizes a fresh ToolContext via createToolContext(). The skill's
  // tools resolve `userId / productId / db / onEvent` through that ctx.
  const skillResultPromise = runForkSkill(
    'generating-strategy',
    JSON.stringify(skillInput),
    generatingStrategyOutputSchema,
    deps,
  );

  // Race the skill against the parent abort signal so a client cancel
  // unblocks the route immediately rather than waiting for runAgent to
  // notice. The skill's child ctx inherits abort propagation via
  // createChildContext when runForkSkill builds it from `ctx`.
  const skillResult: { result: GeneratingStrategyOutput } = await Promise.race([
    skillResultPromise,
    new Promise<{ result: GeneratingStrategyOutput }>((_, reject) => {
      abortSignal.addEventListener(
        'abort',
        () => reject(new PlannerTimeoutError()),
        { once: true },
      );
    }),
  ]);

  if (skillResult.result.status !== 'completed') {
    throw new Error(
      `generating-strategy skill returned status=${skillResult.result.status}`,
    );
  }

  const pathId = skillResult.result.pathId;
  const [row] = await db
    .select()
    .from(strategicPaths)
    .where(eq(strategicPaths.id, pathId))
    .limit(1);
  if (!row) {
    throw new Error(`strategic_paths row not found for pathId=${pathId}`);
  }

  // Re-validate so the SSE consumer gets a typed StrategicPath (the
  // jsonb columns mirror strategicPathSchema's shape).
  const candidate = {
    narrative: row.narrative,
    milestones: row.milestones,
    thesisArc: row.thesisArc,
    contentPillars: row.contentPillars,
    channelMix: row.channelMix,
    phaseGoals: row.phaseGoals,
  };
  const parsed = strategicPathSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `strategic_paths row failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}
