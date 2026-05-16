// Onboarding internal endpoints — all gated on x-shipflare-internal: 1.
// Stateless (no DO). Four routes:
//
//   GET  /internal/onboarding/github-repos       → JSON one-shot
//   POST /internal/onboarding/analyze-url        → SSE: scraping → analyzing → complete
//   POST /internal/onboarding/analyze-repo       → SSE: fetching_tree → reading_manifest → reading_key_files → analyzing → complete
//   POST /internal/onboarding/strategic-path     → SSE: heartbeat (every 15s) → strategic_done
//
// Web routes pass { userId, ...payload }. Core looks up credentials from D1
// using userId so the token never crosses the service binding.

import { z } from "zod";
import {
  strategicPathSchema,
  type StrategicPath,
  type ActivityEventInput,
} from "@shipflare/shared";
import { createDb, user as userTable, eq } from "@shipflare/db";
import { scrapeWebsite, analyzeWebsite } from "./lib/onboarding/scraper";
import { auditSeo } from "./lib/onboarding/seo-audit";
import { getAnthropic } from "./lib/onboarding/anthropic";
import { getGitHubToken, listUserRepos } from "./lib/onboarding/github";
import { scanRepo } from "./lib/onboarding/code-scanner";
import { forwardActivityToCmo } from "./lib/forward-activity";
import type { Env } from "./index";

// ─── Env type (only what this file needs) ──────────────────────────────────

// Subset of the full Worker `Env` consumed by this file. We include the
// CMO binding because Task 9 forwards activity events from the
// strategic-path SSE handler to the user's CMO DO via the shared
// `forwardActivityToCmo` helper (spec 2026-05-15-agent-activity-feed §Task 9).
//
// `STRATEGIC_PATH_FIXTURE` is the trust-boundary-safe replacement for the
// previous body-flag (`_test_fixture`). When `"1"`, the strategic-path
// handler short-circuits Anthropic and emits a deterministic 3-chunk
// schema-valid path so `strategic-path-activity.test.ts` can exercise the
// emit path without a real API key. Only test config sets this binding;
// production never does, so an authenticated browser can no longer force
// fixture mode by spreading `_test_fixture: true` through the web proxy.
interface OnboardingEnv {
  ANTHROPIC_API_KEY?: string;
  STRATEGIC_PATH_FIXTURE?: string;
  DB: D1Database;
  CMO: Env["CMO"];
}

// ─── Input schemas ──────────────────────────────────────────────────────────

const analyzeUrlSchema = z.object({
  userId: z.string().min(1),
  url: z.string().min(1),
});

const analyzeRepoSchema = z.object({
  userId: z.string().min(1),
  repoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
});

const strategicPathInputSchema = z.object({
  userId: z.string().min(1),
  product: z.object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    valueProp: z.string().max(600).nullable().optional(),
    keywords: z.array(z.string().min(1)).max(20),
    category: z.enum([
      "dev_tool",
      "saas",
      "consumer",
      "creator_tool",
      "agency",
      "ai_app",
      "other",
    ]),
    targetAudience: z.string().max(600).nullable().optional(),
  }),
  channels: z.array(z.enum(["x", "reddit", "email"])).min(1),
  state: z.enum(["mvp", "launching", "launched"]),
  launchDate: z.string().datetime().nullable().optional(),
  launchedAt: z.string().datetime().nullable().optional(),
  launchChannel: z
    .enum(["producthunt", "showhn", "both", "other"])
    .nullable()
    .optional(),
  usersBucket: z.enum(["<100", "100-1k", "1k-10k", "10k+"]).nullable().optional(),
  // Task 9 (spec 2026-05-15-agent-activity-feed): when the caller passes a
  // `runId`, the SSE handler forwards `subagent_dispatch` /
  // `subagent_text_delta` / `subagent_finish` activity events to the user's
  // CMO DO keyed by this id. Optional so legacy callers (old web builds)
  // keep working — without a `runId` the forward becomes a no-op.
  runId: z.string().uuid().optional(),
});

// ─── Test fixture (env-gated) ──────────────────────────────────────────────

// Minimal schema-valid strategic path emitted when env.STRATEGIC_PATH_FIXTURE
// is "1". Built once at module load so the JSON.stringify happens once.
// `narrative` is padded to clear `min(200)`; milestones/thesisArc/
// contentPillars/channelMix/phaseGoals satisfy strategicPathSchema. We
// re-`parse()` this with the same schema as production so the downstream
// `/api/onboarding/commit` invariant — that `path` is schema-valid — still
// holds for fixture-mode runs.
const FIXTURE_STRATEGIC_PATH_JSON: string = JSON.stringify({
  narrative:
    "Fixture narrative for tests. " +
    "This deterministic narrative pads past the 200-character minimum so the strategic path schema accepts it. " +
    "It exists only because the strategic-path SSE handler short-circuits Anthropic when STRATEGIC_PATH_FIXTURE is set in env.",
  milestones: [
    {
      atDayOffset: 7,
      title: "Fixture milestone 1",
      successMetric: "fixture metric 1",
      phase: "foundation",
    },
    {
      atDayOffset: 14,
      title: "Fixture milestone 2",
      successMetric: "fixture metric 2",
      phase: "momentum",
    },
    {
      atDayOffset: 30,
      title: "Fixture milestone 3",
      successMetric: "fixture metric 3",
      phase: "compound",
    },
  ],
  thesisArc: [
    {
      weekStart: "2026-01-05",
      theme: "fixture theme",
      angleMix: ["story"],
    },
  ],
  contentPillars: ["pillar a", "pillar b", "pillar c"],
  channelMix: {
    x: {
      repliesPerDay: 5,
      preferredHours: [9, 13, 17],
      preferredCommunities: null,
    },
  },
  phaseGoals: {
    foundation: "fixture foundation goal",
  },
});

// ─── Strategic path planner prompt ─────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Head of Growth for an indie product. Produce a 30-day marketing strategy as a strict JSON object.

EXACT REQUIRED SHAPE (field names must match exactly — no substitutions):

{
  "narrative": string,           // 200–2400 chars, 2–3 paragraphs explaining strategic thesis
  "milestones": [                // 3–12 items
    {
      "atDayOffset": number,     // integer, days from today (e.g. 7, 14, 30)
      "title": string,           // max 140 chars
      "successMetric": string,   // max 240 chars — measurable success criteria
      "phase": string            // MUST be one of: "foundation" | "audience" | "momentum" | "launch" | "compound" | "steady"
    }
  ],
  "thesisArc": [                 // 1–12 items, one per week
    {
      "weekStart": string,       // YYYY-MM-DD, Monday 00:00 UTC
      "theme": string,           // max 240 chars
      "angleMix": string[],      // REQUIRED, 1–7 items, each MUST be one of: "claim" | "story" | "contrarian" | "howto" | "data" | "case" | "synthesis"
      "posts": {                 // optional
        "x"?: number,            // 0–14
        "reddit"?: number,       // 0–14
        "email"?: number         // 0–14
      }
    }
  ],
  "contentPillars": string[],    // 3–4 short labels, max 60 chars each
  "channelMix": {                // at least one non-null; only include channels from input.channels
    "x"?: {
      "repliesPerDay": number,   // 0–50, nullable
      "preferredHours": number[], // REQUIRED, 1–6 UTC hours (0–23, e.g. [9, 13, 17])
      "preferredCommunities": string[] | null
    },
    "reddit"?: {
      "repliesPerDay": number,   // 0–50, nullable
      "preferredHours": number[], // REQUIRED, 1–6 UTC hours
      "preferredCommunities": string[] | null  // e.g. ["r/SaaS", "r/startups"]
    },
    "email"?: {
      "repliesPerDay": number,   // 0–50, nullable
      "preferredHours": number[], // REQUIRED, 1–6 UTC hours
      "preferredCommunities": string[] | null
    }
  },
  "phaseGoals": {                // all fields optional strings, max 240 chars each
    "foundation"?: string,
    "audience"?: string,
    "momentum"?: string,
    "launch"?: string,
    "compound"?: string,
    "steady"?: string
  }
}

CRITICAL RULES:
- Use "successMetric" NOT "summary" or "dueOffsetDays" — use "atDayOffset"
- "angleMix" is REQUIRED on every thesisArc entry (not optional)
- "preferredHours" is REQUIRED on every channelMix entry — must have 1–6 elements
- Only include channels in channelMix that appear in input.channels
- Anchor thesisArc[0].weekStart to the weekStart value from input (Monday 00:00 UTC)

VALID EXAMPLE (small but schema-compliant):
{
  "narrative": "This is a two-paragraph strategic narrative explaining the go-to-market approach for the product. It covers the core value proposition and target audience clearly. The second paragraph outlines the 30-day growth thesis and why these channels and cadences were chosen.",
  "milestones": [
    {"atDayOffset": 7, "title": "Soft launch on Show HN", "successMetric": "100 unique visits in first 24h", "phase": "momentum"},
    {"atDayOffset": 14, "title": "First 10 paying users", "successMetric": "10 active subscriptions", "phase": "launch"},
    {"atDayOffset": 30, "title": "Hit MRR target", "successMetric": "$1k MRR", "phase": "compound"}
  ],
  "thesisArc": [
    {"weekStart": "<weekStart from input>", "theme": "Build in public", "angleMix": ["story", "data"], "posts": {"x": 3, "reddit": 1}},
    {"weekStart": "<next Monday>", "theme": "Social proof", "angleMix": ["case", "claim"], "posts": {"x": 4}}
  ],
  "contentPillars": ["Product updates", "Industry insight", "Customer stories"],
  "channelMix": {
    "x": {"repliesPerDay": 5, "preferredHours": [9, 13, 17], "preferredCommunities": null},
    "reddit": {"repliesPerDay": 0, "preferredHours": [10, 15], "preferredCommunities": ["r/SaaS"]}
  },
  "phaseGoals": {
    "foundation": "Ship docs and landing page",
    "audience": "Grow X following to 500",
    "momentum": "100 signups before launch",
    "launch": "Hit 1k visits on launch day",
    "compound": "Convert 1% of visitors to paid",
    "steady": "Sustain $1k MRR"
  }
}

Respond with ONLY the JSON object, no surrounding prose or markdown fences.`;

// ─── Phase / date helpers ───────────────────────────────────────────────────

type ProductState = "mvp" | "launching" | "launched";
type LaunchPhase =
  | "foundation"
  | "audience"
  | "momentum"
  | "launch"
  | "compound"
  | "steady";

const MS_PER_DAY = 86_400_000;

function deriveCurrentPhase(
  state: ProductState,
  launchDate: Date | null,
  launchedAt: Date | null,
  now = new Date(),
): LaunchPhase {
  if (state === "launched") {
    if (!launchedAt) return "steady";
    const daysSince = (now.getTime() - launchedAt.getTime()) / MS_PER_DAY;
    return daysSince <= 30 ? "compound" : "steady";
  }
  if (!launchDate) return "foundation";
  const daysToLaunch = (launchDate.getTime() - now.getTime()) / MS_PER_DAY;
  if (daysToLaunch <= 0) return "launch";
  if (daysToLaunch <= 7) return "momentum";
  if (daysToLaunch <= 28) return "audience";
  return "foundation";
}

function isoMondayUTC(d: Date): string {
  const date = new Date(d);
  const day = date.getUTCDay();
  const offset = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

// ─── SSE helper ─────────────────────────────────────────────────────────────

const HEARTBEAT_MS = 15_000;
const PLAN_TIMEOUT_MS = 180_000;

function sseStream(
  producer: (send: (obj: Record<string, unknown>) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`));
        } catch {
          // controller already closed
        }
      };
      try {
        await producer(send);
      } catch (err) {
        send({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

// ─── Main dispatcher ─────────────────────────────────────────────────────────

export async function handleOnboardingInternal(
  request: Request,
  env: OnboardingEnv,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.headers.get("x-shipflare-internal") !== "1") {
    return new Response("forbidden", { status: 403 });
  }
  // The strategic-path SSE handler skips this gate when env.STRATEGIC_PATH_FIXTURE
  // is "1" (the fixture path never calls Anthropic). All other routes still
  // require the key — the per-route fixture-mode check below covers
  // strategic-path-activity.test.ts running against an empty `.dev.vars`.
  const path = url.pathname;
  if (
    !env.ANTHROPIC_API_KEY &&
    path !== "/internal/onboarding/strategic-path"
  ) {
    return Response.json({ error: "anthropic_not_configured" }, { status: 503 });
  }

  const db = createDb(env.DB);

  // ── GET /internal/onboarding/github-repos?userId=... ────────────────────
  if (path === "/internal/onboarding/github-repos" && request.method === "GET") {
    const userId = url.searchParams.get("userId");
    if (!userId) {
      return Response.json({ error: "userId required" }, { status: 400 });
    }
    const token = await getGitHubToken(db, userId);
    if (!token) {
      return Response.json({ error: "No GitHub account linked" }, { status: 404 });
    }
    try {
      const repos = await listUserRepos(token);
      const u = await db
        .select({ name: userTable.name })
        .from(userTable)
        .where(eq(userTable.id, userId))
        .get();
      return Response.json({ repos, username: u?.name ?? null });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to fetch repos" },
        { status: 502 },
      );
    }
  }

  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // ── POST /internal/onboarding/analyze-url → JSON ────────────────────────
  // Returns plain JSON (not SSE) because stage-scanning.tsx calls res.json()
  // on the extract endpoint response. The scrape+analyze round-trip is fast
  // enough that progress events would have no meaningful UX effect.
  if (path === "/internal/onboarding/analyze-url") {
    let body: z.infer<typeof analyzeUrlSchema>;
    try {
      body = analyzeUrlSchema.parse(await request.json());
    } catch (err) {
      return Response.json(
        { error: "invalid_request", detail: err instanceof Error ? err.message : "" },
        { status: 400 },
      );
    }
    const scraped = await scrapeWebsite(body.url);
    const [analysis, seoAudit] = await Promise.all([
      analyzeWebsite(scraped, env.ANTHROPIC_API_KEY!),
      auditSeo(body.url),
    ]);
    return Response.json({
      url: body.url,
      name: analysis.productName,
      description: analysis.oneLiner,
      keywords: analysis.keywords,
      valueProp: analysis.valueProp,
      targetAudience: analysis.targetAudience,
      ogImage: scraped.ogImage,
      seoAudit,
    });
  }

  // ── POST /internal/onboarding/analyze-repo → SSE ────────────────────────
  if (path === "/internal/onboarding/analyze-repo") {
    let body: z.infer<typeof analyzeRepoSchema>;
    try {
      body = analyzeRepoSchema.parse(await request.json());
    } catch (err) {
      return Response.json(
        { error: "invalid_request", detail: err instanceof Error ? err.message : "" },
        { status: 400 },
      );
    }
    return sseStream(async (send) => {
      const token = await getGitHubToken(db, body.userId);
      if (!token) {
        send({ type: "error", error: "No GitHub account linked" });
        return;
      }
      const scan = await scanRepo(
        body.repoFullName,
        token,
        env.ANTHROPIC_API_KEY!,
        (phase) => {
          send({ type: "progress", phase });
        },
      );
      send({
        type: "complete",
        data: {
          url: scan.url,
          name: scan.productAnalysis.productName,
          description: scan.productAnalysis.oneLiner,
          keywords: scan.productAnalysis.keywords,
          valueProp: scan.productAnalysis.valueProp,
          targetAudience: scan.productAnalysis.targetAudience,
          ogImage: null,
          seoAudit: null,
        },
      });
    });
  }

  // ── POST /internal/onboarding/strategic-path → SSE ──────────────────────
  if (path === "/internal/onboarding/strategic-path") {
    let body: z.infer<typeof strategicPathInputSchema>;
    try {
      body = strategicPathInputSchema.parse(await request.json());
    } catch (err) {
      return Response.json(
        { error: "invalid_request", detail: err instanceof Error ? err.message : "" },
        { status: 400 },
      );
    }
    const fixtureMode = env.STRATEGIC_PATH_FIXTURE === "1";
    // Non-fixture requests still require a real API key — bail before we
    // open the SSE stream so the client gets a clean 503 instead of an
    // SSE `error` event.
    if (!fixtureMode && !env.ANTHROPIC_API_KEY) {
      return Response.json(
        { error: "anthropic_not_configured" },
        { status: 503 },
      );
    }
    return sseStream(async (send) => {
      const launchDate = body.launchDate ? new Date(body.launchDate) : null;
      const launchedAt = body.launchedAt ? new Date(body.launchedAt) : null;
      const currentPhase = deriveCurrentPhase(body.state, launchDate, launchedAt);
      const today = new Date();
      const weekStart = isoMondayUTC(today);

      const userMessage = JSON.stringify(
        {
          today: today.toISOString().slice(0, 10),
          weekStart,
          product: body.product,
          state: body.state,
          currentPhase,
          channels: body.channels,
          launchDate: body.launchDate ?? null,
          launchedAt: body.launchedAt ?? null,
          launchChannel: body.launchChannel ?? null,
          usersBucket: body.usersBucket ?? null,
        },
        null,
        2,
      );

      // Heartbeat every 15s while the Anthropic call runs
      const abortController = new AbortController();
      const heartbeat = setInterval(
        () => send({ type: "heartbeat" }),
        HEARTBEAT_MS,
      );
      const timeoutId = setTimeout(
        () => abortController.abort(),
        PLAN_TIMEOUT_MS,
      );

      // Activity-forwarding helper. No-op when `runId` is missing
      // (back-compat with old web builds that don't pass one). `userId`
      // is required by the input schema so we don't need a separate
      // guard for it. The full `Env` shape isn't visible from this
      // file's `OnboardingEnv` (it only declares what onboarding needs),
      // so we cast at the binding boundary — `forwardActivityToCmo`
      // only touches `env.CMO` which is part of `OnboardingEnv`.
      const runId = body.runId ?? null;
      const forward = runId
        ? (evt: ActivityEventInput): void =>
            forwardActivityToCmo(ctx, env as unknown as Env, body.userId, evt)
        : (): void => undefined;

      const dispatchStart = Date.now();
      forward({
        conversationId: null,
        parentTurnId: null,
        runId,
        parentEventId: null,
        sourceAgent: "strategic-planner",
        kind: "subagent_dispatch",
        payload: {
          kind: "subagent_dispatch",
          subAgent: "strategic-planner",
          promptPreview: `Plan for ${body.product?.name ?? "product"}`,
        },
      });

      try {
        let text = "";
        if (fixtureMode) {
          // Fixture path — emit a deterministic 3-chunk sequence so tests
          // can assert ordering without burning Anthropic budget. The
          // concatenated output is the schema-valid FIXTURE_STRATEGIC_PATH_JSON
          // so `strategicPathSchema.parse()` below still runs and the
          // downstream `/api/onboarding/commit` invariant is preserved.
          const total = FIXTURE_STRATEGIC_PATH_JSON;
          const third = Math.floor(total.length / 3);
          const chunks = [
            total.slice(0, third),
            total.slice(third, third * 2),
            total.slice(third * 2),
          ];
          for (const chunk of chunks) {
            text += chunk;
            forward({
              conversationId: null,
              parentTurnId: null,
              runId,
              parentEventId: null,
              sourceAgent: "strategic-planner",
              kind: "subagent_text_delta",
              payload: {
                kind: "subagent_text_delta",
                subAgent: "strategic-planner",
                text: chunk,
              },
            });
          }
        } else {
          const client = getAnthropic(env.ANTHROPIC_API_KEY!);
          const stream = client.messages.stream(
            {
              model: "claude-sonnet-4-6",
              max_tokens: 4096,
              system: SYSTEM_PROMPT,
              messages: [{ role: "user", content: userMessage }],
            },
            { signal: abortController.signal },
          );

          // Batched text-delta forwarding — flush on the next delta
          // after the buffer hits 256 chars OR 200 ms have elapsed since
          // the last flush. There is no setInterval watchdog: late
          // deltas trigger the time-based path naturally, and the final
          // `flush()` after `stream.finalMessage()` drains any tail
          // smaller than 256 chars. Keeps the activity feed snappy
          // without spraying a forward per token.
          let buf = "";
          let lastFlush = Date.now();
          const flush = (): void => {
            if (!buf) return;
            forward({
              conversationId: null,
              parentTurnId: null,
              runId,
              parentEventId: null,
              sourceAgent: "strategic-planner",
              kind: "subagent_text_delta",
              payload: {
                kind: "subagent_text_delta",
                subAgent: "strategic-planner",
                text: buf,
              },
            });
            buf = "";
            lastFlush = Date.now();
          };
          stream.on("text", (delta: string) => {
            text += delta;
            buf += delta;
            if (buf.length >= 256 || Date.now() - lastFlush >= 200) {
              flush();
            }
          });
          await stream.finalMessage();
          flush();
        }

        const m = text.match(/\{[\s\S]*\}/);
        if (!m) {
          forward({
            conversationId: null,
            parentTurnId: null,
            runId,
            parentEventId: null,
            sourceAgent: "strategic-planner",
            kind: "subagent_finish",
            payload: {
              kind: "subagent_finish",
              subAgent: "strategic-planner",
              status: "error",
              durationMs: Date.now() - dispatchStart,
              summary: "no_json_in_response",
            },
          });
          send({ type: "error", error: "no_json_in_response" });
          return;
        }
        const raw = JSON.parse(m[0]) as unknown;
        // Fixture mode emits FIXTURE_STRATEGIC_PATH_JSON which IS
        // schema-valid, so the same `strategicPathSchema.parse()` runs
        // on both branches. This preserves the downstream invariant
        // that `path` is validated before reaching
        // `/api/onboarding/commit` — the trust-boundary fix from the
        // Task 9 code review.
        const strategicPath: StrategicPath = strategicPathSchema.parse(raw);
        forward({
          conversationId: null,
          parentTurnId: null,
          runId,
          parentEventId: null,
          sourceAgent: "strategic-planner",
          kind: "subagent_finish",
          payload: {
            kind: "subagent_finish",
            subAgent: "strategic-planner",
            status: "ok",
            durationMs: Date.now() - dispatchStart,
            summary: fixtureMode ? "plan ready (fixture)" : "plan ready",
          },
        });
        send({ type: "strategic_done", path: strategicPath });
      } catch (err) {
        forward({
          conversationId: null,
          parentTurnId: null,
          runId,
          parentEventId: null,
          sourceAgent: "strategic-planner",
          kind: "subagent_finish",
          payload: {
            kind: "subagent_finish",
            subAgent: "strategic-planner",
            status: "error",
            durationMs: Date.now() - dispatchStart,
            summary:
              err instanceof Error
                ? err.message.slice(0, 200)
                : String(err).slice(0, 200),
          },
        });
        if (abortController.signal.aborted) {
          send({ type: "error", error: "planner_timeout" });
          return;
        }
        send({
          type: "error",
          error: err instanceof Error ? err.message : "PlanGenerationError",
        });
      } finally {
        clearInterval(heartbeat);
        clearTimeout(timeoutId);
      }
    });
  }

  return new Response("not found", { status: 404 });
}
