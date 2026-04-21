import { type NextRequest } from 'next/server';
import { join } from 'node:path';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import {
  strategicPathSchema,
  type StrategicPath,
} from '@/agents/schemas';
import { derivePhase } from '@/lib/launch-phase';
import { acquireRateLimit } from '@/lib/rate-limit';
import { recordPipelineEvent } from '@/lib/pipeline-events';
import { createLogger, loggerForRequest } from '@/lib/logger';

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

const strategicSkill = loadSkill(
  join(process.cwd(), 'src/skills/strategic-planner'),
);

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
        const path = await Promise.race([
          runStrategic(body, currentPhase),
          new Promise<never>((_, reject) => {
            abortController.signal.addEventListener('abort', () =>
              reject(new PlannerTimeoutError()),
            );
          }),
        ]);

        await recordPipelineEvent({
          userId,
          stage: 'launch_plan_completed',
          metadata: {
            traceId,
            pillars: path.contentPillars.length,
            thesisWeeks: path.thesisArc.length,
            scope: 'strategic_only',
          },
        });

        log.info(
          `strategic plan done user=${userId} pillars=${path.contentPillars.length}`,
        );

        cleanup({ type: 'strategic_done', path });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await recordPipelineEvent({
          userId,
          stage: 'launch_plan_failed',
          metadata: { traceId, error: message },
        });

        if (err instanceof PlannerTimeoutError) {
          log.error(
            `strategic plan timeout user=${userId} after ${PLAN_TIMEOUT_MS}ms`,
          );
          cleanup({ type: 'error', error: 'planner_timeout' });
          return;
        }

        log.error(`strategic plan failed user=${userId}: ${message}`);
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

async function runStrategic(
  body: RequestBody,
  currentPhase: ReturnType<typeof derivePhase>,
): Promise<StrategicPath> {
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
  return path;
}
