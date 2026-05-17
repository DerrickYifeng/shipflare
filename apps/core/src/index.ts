/**
 * @shipflare/core — DO host Worker entry.
 *
 * S2.6 wires the real routing:
 *
 * - `/healthz` → quick liveness probe
 * - `/agents/<role>/<userId>/mcp[/...]` → Phase 1 internal MCP entry,
 *   JWT-protected (HS256, signed by `apps/web` via `MCP_JWT_SECRET`).
 *   Phase 1 only exposes `cmo` here; HoG / SMM ride along on the CMO's
 *   `addMcpServer` in-process pipe.
 * - `/external/agents/<role>/<userId>/mcp[/...]` → Phase 2 external MCP
 *   entry for 3rd-party MCP clients (Claude Desktop, Cursor, founder's
 *   own LLM stack). Long-lived (30d) tokens signed with a SEPARATE
 *   `EXTERNAL_MCP_SECRET` so a leaked browser-session token can't
 *   impersonate a 3rd-party client (and vice-versa). Each employee class
 *   (CMO / HoG / SMM) is exposed; scope is recorded in the token but
 *   per-tool gating is forward-compat (P2-A.followup).
 * - `/agents/<role>/<userId>/internal/<path>` → Service-Binding-only routes
 *   for sibling-agent RPC. Gated by `x-shipflare-internal: 1` (Cloudflare
 *   strips this header from public-edge traffic, so only intra-network
 *   callers can set it; the DO re-checks defensively).
 * - `scheduled()` → fleet-wide rollups only (currently the 6h growth
 *   snapshot). Per-user daily relays moved to `CMO.alarm()` in 5.1c.13;
 *   the legacy `/internal/cron-tick` fan-out was retired in 5.1c.16.
 *
 * Phase 0 spike #2: parameterized `DurableObjectNamespace<CMO>` is required
 * (not bare) for `addMcpServer`'s generic constraint to resolve, and the
 * `import { CMO }` then `export { CMO }` form is the wrangler-friendly way
 * to expose the DO class.
 *
 * Phase 0 spike #8: Service Bindings strip `host` / `cf-connecting-ip` from
 * forwarded requests — never depend on those for auth. Pass identity via
 * JWT (external) or the `x-shipflare-internal` header (internal).
 *
 * Phase 0 spike #9: `SELF.scheduled()` is broken in vitest-pool-workers —
 * tests invoke `worker.scheduled!(ctl, env, ctx)` directly instead.
 */

import { handleOnboardingInternal } from "./onboarding-routes";
import { verifyJwt } from "./lib/jwt";
import { validateExternalAccess } from "./lib/external-auth";
import { transportName } from "./lib/do-name";
import { inferTimezone } from "./lib/tz-inference";
import { ROLE_REGISTRY, isValidRole, type RoleSlug } from "@shipflare/shared";
import {
  createDb,
  channels as channelsTable,
  growthSnapshots as growthSnapshotsTable,
} from "@shipflare/db";

import { CMO } from "./agents/cmo/CMO";
import { HoG } from "./agents/head-of-growth/HeadOfGrowth";
import { SMM } from "./agents/social-media-manager/SocialMediaMgr";
// `XMcpAgent` / `RedditMcpAgent` are type-imported here (Env declaration).
// The value re-exports below put the classes on the module graph so wrangler
// can discover them once S5.3 uncomments the X_MCP / REDDIT_MCP bindings.
import type { XMcpAgent } from "./agents/platforms/x/XMcpAgent";
import type { RedditMcpAgent } from "./agents/platforms/reddit/RedditMcpAgent";

// Value re-export so wrangler can discover the DO classes via the module
// graph rooted at `main`. (We `import` the classes above as values so they
// can also be used in the EMPLOYEE_CLASSES dispatch table for the external
// MCP route — `export { X }` is enough on its own when there's already an
// `import { X }` above, but we keep the explicit re-export for grep-ability.)
export { CMO, HoG, SMM };
// Re-export the platform DO classes so wrangler can discover them via the
// module graph rooted at `main`.
export { XMcpAgent } from "./agents/platforms/x/XMcpAgent";
export { RedditMcpAgent } from "./agents/platforms/reddit/RedditMcpAgent";

export interface Env {
  DB: D1Database;
  // DO bindings — 3 employee agents + 2 platform tool MCPs.
  CMO: DurableObjectNamespace<CMO>;
  HOG: DurableObjectNamespace<HoG>;
  SMM: DurableObjectNamespace<SMM>;
  X_MCP: DurableObjectNamespace<XMcpAgent>;
  REDDIT_MCP: DurableObjectNamespace<RedditMcpAgent>;
  // Workflow binding — added when AgentPlanWorkflow lands (S6).
  // AGENT_PLAN_WORKFLOW: Workflow;
  // Secrets (wrangler secret put ...)
  ANTHROPIC_API_KEY: string;
  XAI_API_KEY: string;
  MCP_JWT_SECRET: string;
  /**
   * Phase 2 external MCP signing secret. SEPARATE from MCP_JWT_SECRET so a
   * leaked browser-session token (60s TTL, used by `/agents/<role>/<userId>/mcp`)
   * cannot be used to impersonate a 3rd-party MCP client (30d TTL,
   * `/external/agents/<role>/<userId>/mcp`).
   */
  EXTERNAL_MCP_SECRET: string;
  CHANNEL_ENC_KEY: string;
  // P2-F — Web Push (RFC 8030 / VAPID). Public key is also bundled into
  // the browser at build time as NEXT_PUBLIC_VAPID_PUBLIC in apps/web, and
  // private key is used by the CMO to sign per-push VAPID JWTs.
  // `VAPID_SUBJECT` must be a mailto: or https: URI per RFC 8292 §2.1.
  // Generate with `generateVapidKeypair()` in src/lib/web-push.ts.
  VAPID_PUBLIC: string;
  VAPID_PRIVATE: string;
  VAPID_SUBJECT: string;
  /**
   * Workers Analytics Engine dataset binding for ops telemetry —
   * agent_run / skill_invocation / tool_invocation events. Written via
   * `@shipflare/shared#writeAgentEvent` and queried back via
   * the Cloudflare SQL API. Replaces the legacy `activity_events` D1
   * table (deleted in Phase 5 of the CF-native chat migration).
   */
  TELEMETRY: AnalyticsEngineDataset;
  /**
   * Phase 7 wiring (CF-native migration): `withOAuthProvider` wraps the
   * external MCP route for CMO so 3rd-party clients (Claude Desktop,
   * Cursor, the founder's own LLM stack) authenticate via the standard
   * MCP OAuth flow. The audience claim is published; the signing key is
   * provisioned via `wrangler secret put MCP_OAUTH_JWT_SIGNING_KEY`.
   *
   * Scaffolded in Phase 0 so the `Env` type stays consistent across the
   * migration; the route handler that consumes these lands in Phase 7.
   */
  MCP_OAUTH_AUDIENCE: string;
  // TODO(Phase 7): the route handler that installs `withOAuthProvider` must
  // assert this is non-empty at startup — bindings injected by Wrangler can
  // silently arrive as `""` if `wrangler secret put MCP_OAUTH_JWT_SIGNING_KEY`
  // was never run for the environment.
  MCP_OAUTH_JWT_SIGNING_KEY: string;
}

// EMPLOYEE_CLASSES dispatch table for the legacy external MCP route was
// retired in Task 5.1b (CF-native chat migration). All three employee
// classes are now AIChatAgent subclasses; AIChatAgent has no `.serve()`
// HTTP-handler shim, so the external MCP path is offline until Phase 7
// reinstalls a withOAuthProvider-wrapped surface. See `handleExternalMcpRequest`
// below — it returns 503 with a Phase 7 marker for any role.

/**
 * `/agents/<role>/<userId>/mcp[/...]` — Phase 1 internal MCP entry. The
 * trailing `(?:\/|$)` covers BOTH the initial handshake POST to `/mcp` and
 * any subsequent McpAgent sub-paths (e.g. `/mcp/messages`).
 */
const MCP_ROUTE = /^\/agents\/([a-z-]+)\/([^/]+)\/mcp(?:\/|$)/;

/**
 * `/agents/cmo/<userId>` (no /mcp suffix) — Browser chat WebSocket.
 *
 * Post-Phase-8 (CF-native chat migration): the web client opens this WS
 * after fetching a short-lived JWT from `/api/agent-token`. The token is
 * passed in the `?token=` query string (browsers can't set Authorization
 * headers on `new WebSocket()`). `handleCmoWsRequest` verifies the JWT
 * before forwarding to the DO; the DO is AIChatAgent so the WS upgrade
 * is handled by the framework's native chat transport.
 *
 * The trailing `$` (no further path) is what discriminates this from the
 * `/mcp[/...]` route — the regex order in `routeRequest()` checks MCP_ROUTE
 * first so streamable-HTTP handshakes still flow through `streamableHttpProxy`.
 */
const CMO_WS_ROUTE = /^\/agents\/cmo\/([^/]+)$/;

/**
 * `/external/agents/<role>/<userId>/mcp[/...]` — Phase 2 external MCP entry.
 *
 * Long-lived (30d) tokens signed with `EXTERNAL_MCP_SECRET` (distinct from
 * the browser-session `MCP_JWT_SECRET`). Token claims must match the URL
 * `<role>` and `<userId>` segments exactly (or `role === "*"` for the
 * admin-issued any-role token).
 *
 * Per Phase 0 spike #3 finding: `McpAgent.serve()` defaults its binding to
 * `"MCP_OBJECT"`. We MUST override with `{ binding: "<NAME>" }` explicitly
 * for each employee class; otherwise the SDK will look up a binding name
 * that doesn't exist in our wrangler config.
 */
const EXTERNAL_MCP_ROUTE =
  /^\/external\/agents\/([a-z-]+)\/([^/]+)\/mcp(?:\/|$)/;

/**
 * `/agents/<role>/<userId>/internal/<path>` — Service-Binding-only RPC.
 * The captured group `(\/internal\/.+)` is forwarded verbatim to the DO so
 * the DO's fetch handler sees the same `/internal/...` path it expects.
 */
const INTERNAL_ROUTE = /^\/agents\/([a-z-]+)\/([^/]+)(\/internal\/.+)$/;

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // CORS — apps/web (shipflare.ai) talks to core (core.shipflare.ai)
    // directly via the MCP streamable HTTP transport. Browser preflight
    // (OPTIONS) MUST short-circuit before any auth gate, otherwise CF
    // returns 401 with no CORS headers and the browser drops the request
    // with "Failed to fetch". Non-browser callers (CLI, service-binding
    // sibling agents, claude-desktop) ignore these headers harmlessly.
    const cors = corsHeadersFor(request);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const res = await routeRequest(request, env, ctx, url);
    return withCorsHeaders(res, cors);
  },

  async scheduled(
    _event: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // Per-user daily relay moved to `CMO.alarm()` in 5.1c.13, so this
    // handler is now fleet-wide rollups only.
    //
    // Growth snapshots: capture per-(user, platform) metrics into D1 every
    // 6h tick. Phase 1 stores empty metrics {}; a later task wires real
    // collection. Per-(user, platform) failures are isolated via the
    // try/catch inside snapshotGrowth.
    //
    // Phase 0 spike #9: don't use `SELF.scheduled()` to test this; call
    // the handler directly from tests instead.
    try {
      await snapshotGrowth(env);
    } catch (err) {
      console.error("[scheduled] growth snapshot fan-out failed:", err);
    }
  },
} satisfies ExportedHandler<Env>;

// ──────────────────────────────────────────────────────────────────────────
// Growth snapshot helpers — called from `scheduled()` every 6h.
//
// Phase 1: `fetchPlatformMetrics` returns an empty object. A future task
// will wire real metric collection via the platform DO stubs (env.X_MCP /
// env.REDDIT_MCP). The schema + cron cadence are stable; only the metric
// payload needs to be filled in later.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Snapshot growth metrics for every (userId, platform) channel row in D1.
 *
 * Failures are per-(user, platform) — one bad row doesn't block the rest.
 * The function itself is wrapped in try/catch in `scheduled()`.
 */
async function snapshotGrowth(env: Env): Promise<void> {
  const db = createDb(env.DB);
  // Distinct (userId, platform) pairs from channels rows. Only platforms
  // with a channel row are snapshotted — Reddit "always-on" rows that have
  // no channel entry are excluded until real collection lands.
  const rows = await db
    .selectDistinct({
      userId: channelsTable.userId,
      platform: channelsTable.platform,
    })
    .from(channelsTable);

  await Promise.all(
    rows.map(async ({ userId, platform }) => {
      if (platform !== "x" && platform !== "reddit") return;
      try {
        const metrics = await fetchPlatformMetrics(env, userId, platform);
        await db.insert(growthSnapshotsTable).values({
          id: crypto.randomUUID(),
          userId,
          platform,
          capturedAt: new Date(),
          metrics,
          createdAt: new Date(),
        });
      } catch (err) {
        console.warn(
          `[snapshotGrowth] failed for ${userId}/${platform}:`,
          err,
        );
      }
    }),
  );
}

/**
 * Fetch engagement metrics for a given user + platform.
 *
 * Routes to the platform DO's `/internal/<tool>` endpoint via a
 * service-binding fetch. The DO re-checks the `x-shipflare-internal: 1`
 * header defensively; Cloudflare strips this from public-edge traffic.
 *
 * Failures return an empty record so one user's error doesn't break the
 * rest of the cron fan-out. Errors are logged with user/platform context.
 */
async function fetchPlatformMetrics(
  env: Env,
  userId: string,
  platform: "x" | "reddit",
): Promise<Record<string, number>> {
  try {
    if (platform === "x") {
      const id = env.X_MCP.idFromName(userId);
      const stub = env.X_MCP.get(id);
      const res = await stub.fetch(
        new Request("https://internal/internal/x_aggregate_metrics", {
          method: "GET",
          headers: { "x-shipflare-internal": "1" },
        }),
      );
      if (!res.ok) {
        console.warn(
          `[fetchPlatformMetrics] x/${userId} DO returned ${res.status}`,
        );
        return {};
      }
      const json = (await res.json()) as Record<string, unknown>;
      // capturedAt is a string — strip it; caller stores it separately.
      const { capturedAt: _, error: __, ...numeric } = json;
      return numeric as Record<string, number>;
    }

    if (platform === "reddit") {
      const id = env.REDDIT_MCP.idFromName(userId);
      const stub = env.REDDIT_MCP.get(id);
      const res = await stub.fetch(
        new Request("https://internal/internal/reddit_local_metrics", {
          method: "GET",
          headers: { "x-shipflare-internal": "1" },
        }),
      );
      if (!res.ok) {
        console.warn(
          `[fetchPlatformMetrics] reddit/${userId} DO returned ${res.status}`,
        );
        return {};
      }
      const json = (await res.json()) as Record<string, unknown>;
      const { capturedAt: _, error: __, ...numeric } = json;
      return numeric as Record<string, number>;
    }
  } catch (err) {
    console.warn(
      `[fetchPlatformMetrics] ${platform}/${userId} threw:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return {};
}

// ──────────────────────────────────────────────────────────────────────────
// CORS — browser at `https://shipflare.ai` calls core at
// `https://core.shipflare.ai`. Allowlist is small and hardcoded; bump it
// here if we add a new public web origin (preview deploys, etc).
// ──────────────────────────────────────────────────────────────────────────
const CORS_ALLOWED_ORIGINS = new Set([
  "https://shipflare.ai",
  "https://shipflare-web.cdhyfpp.workers.dev",
  "http://localhost:3000",
  "http://localhost:8788",
]);

function corsHeadersFor(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !CORS_ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    // `mcp-session-id` is sent by the SDK on subsequent calls after init.
    // `accept` is explicit because the MCP transport asks for both
    // application/json and text/event-stream.
    "access-control-allow-headers":
      "authorization, content-type, accept, mcp-session-id, mcp-protocol-version",
    // Browser needs to read `mcp-session-id` off the init response so it
    // can echo it back on subsequent posts.
    "access-control-expose-headers": "mcp-session-id",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function withCorsHeaders(
  res: Response,
  cors: Record<string, string>,
): Response {
  if (Object.keys(cors).length === 0) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Pure routing logic, extracted from `fetch()` so the entry point only
// handles CORS + dispatch. Returns the inner response without CORS headers
// — the caller wraps it via `withCorsHeaders`.
// ──────────────────────────────────────────────────────────────────────────
async function routeRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (url.pathname === "/healthz") {
    return Response.json({ ok: true, ts: Date.now() });
  }

  if (url.pathname.startsWith("/internal/onboarding/")) {
    return handleOnboardingInternal(request, env, url, ctx);
  }

  const externalMatch = EXTERNAL_MCP_ROUTE.exec(url.pathname);
  if (externalMatch) {
    const [, role, userId] = externalMatch;
    return handleExternalMcpRequest(request, env, ctx, role!, userId!);
  }

  const internalMatch = INTERNAL_ROUTE.exec(url.pathname);
  if (internalMatch) {
    const [, role, userId, internalPath] = internalMatch;
    return handleInternalRequest(request, env, role!, userId!, internalPath!);
  }

  const mcpMatch = MCP_ROUTE.exec(url.pathname);
  if (mcpMatch) {
    const [, role, userId] = mcpMatch;
    return handleMcpRequest(request, env, role!, userId!);
  }

  const wsMatch = CMO_WS_ROUTE.exec(url.pathname);
  if (wsMatch) {
    const [, userId] = wsMatch;
    return handleCmoWsRequest(request, env, userId!);
  }

  return new Response("not found", { status: 404 });
}

/**
 * Bare WebSocket route for the browser chat surface.
 *
 * Verifies the JWT minted by apps/web's /api/agent-token BEFORE spinning up
 * a DO instance. Defense-in-depth: the DO's onConnect also re-checks the
 * token, but doing it here prevents unnecessary DO spin-ups and protects
 * against cross-user replay (token.name must match the URL's userId) and
 * cross-agent token reuse (token.agent must be "cmo").
 *
 * Browser opens:
 *   wss://core/agents/cmo/<userId>?token=<jwt>
 * Token claims expected:
 *   { userId: <session user id>, agent: "cmo", name: <userId from URL> }
 */
async function handleCmoWsRequest(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  // Reject non-WS traffic early — saves a DO spin-up. The browser always
  // sends `Upgrade: websocket` when opening a WebSocket; anything else is
  // a misconfigured probe or a curl call.
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket upgrade", { status: 426 });
  }

  // Verify the JWT minted by apps/web's /api/agent-token before
  // spinning up a DO instance. Browser opens
  //   wss://core/agents/cmo/<userId>?token=<jwt>
  // and we check the claims match the URL's `userId` (defense against
  // cross-user replay) and that the agent claim is `cmo` (defense
  // against tokens minted for hog/smm being used here).
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return new Response("missing token", { status: 401 });
  }

  let claims: Record<string, unknown>;
  try {
    claims = await verifyJwt(token, env.MCP_JWT_SECRET);
  } catch {
    return new Response("invalid token", { status: 401 });
  }

  if (claims["agent"] !== "cmo") {
    return new Response("token agent mismatch", { status: 401 });
  }
  if (claims["name"] !== userId) {
    return new Response("token name mismatch", { status: 401 });
  }

  // Infer the founder's timezone from the WS handshake so the CMO DO can
  // bootstrap `founder_context.tz` on first connect (5.1c.14 / .15).
  //   Priority: ?tz=<IANA>  →  request.cf.timezone  →  "UTC"
  // The browser provides the query param via
  //   `Intl.DateTimeFormat().resolvedOptions().timeZone` (apps/web's
  //   useCmoChat). Cloudflare's IP-geo guess is the fallback for clients
  //   that don't send the query (older builds, MCP clients, etc).
  const tzFromQuery = url.searchParams.get("tz") ?? undefined;
  const tzFromCf = (request.cf as { timezone?: string } | undefined)?.timezone;
  const inferredTz = inferTimezone(tzFromQuery, tzFromCf);

  // Forward via header so the DO's fetch() can read `x-inferred-tz`
  // without re-parsing the URL. Use `new Request(url, request)` so the
  // WS upgrade machinery (Upgrade / Connection / Sec-WebSocket-*, plus
  // the internal `webSocket` field workerd attaches to upgrade Requests)
  // is carried over from the original. Mutating `.headers` after
  // construction keeps every existing handshake header intact and just
  // overlays our `x-inferred-tz` on top.
  const forwarded = new Request(request.url, request);
  forwarded.headers.set("x-inferred-tz", inferredTz);

  const stub = env.CMO.get(env.CMO.idFromName(transportName(userId)));
  // Forward the request (with `x-inferred-tz` overlay) so `onConnect`'s
  // ctx.request.url retains the `?token=...` query string AND the
  // original `/agents/cmo/<userId>` path (CMO uses pathname to
  // discriminate this from /mcp transport WS).
  return stub.fetch(forwarded);
}

// ──────────────────────────────────────────────────────────────────────────
// /agents/<role>/<userId>/internal/<path>
// Forwards verbatim to the DO's fetch() handler. The DO re-verifies the
// `x-shipflare-internal: 1` header (defense in depth — see CMO.fetch).
// ──────────────────────────────────────────────────────────────────────────
async function handleInternalRequest(
  request: Request,
  env: Env,
  role: string,
  userId: string,
  internalPath: string,
): Promise<Response> {
  // Worker-level gate. The DO has its own re-check; this short-circuits
  // before we even spin up the DO stub.
  if (request.headers.get("x-shipflare-internal") !== "1") {
    return new Response("forbidden", { status: 403 });
  }
  if (!isValidRole(role)) {
    return new Response("unknown role", { status: 404 });
  }
  const entry = ROLE_REGISTRY[role as RoleSlug];
  // The `Env` interface only declares bindings that are currently configured
  // in wrangler.jsonc. Indexing by an arbitrary string (entry.binding) needs
  // an explicit widening cast — the lookup is validated against `undefined`
  // below before use.
  const ns = (env as unknown as Record<string, unknown>)[entry.binding] as
    | DurableObjectNamespace
    | undefined;
  if (!ns) {
    return new Response(`binding "${entry.binding}" not deployed`, {
      status: 503,
    });
  }
  // McpAgent.getTransportType() requires a transport prefix on the DO name.
  // All DO lookups — MCP and internal alike — must use this form because
  // onStart() → initTransport() runs before fetch() on every cold start.
  const stub = ns.get(ns.idFromName(transportName(userId)));

  // Strip the public path prefix — the DO's fetch handler expects
  // `/internal/<path>`, not `/agents/<role>/<userId>/internal/<path>`.
  return stub.fetch(new Request(`https://internal${internalPath}`, request));
}

// ──────────────────────────────────────────────────────────────────────────
// /agents/<role>/<userId>/mcp
//
// Task 5.1b (CF-native chat migration): CMO is now an AIChatAgent and no
// longer speaks the MCP transport. The legacy `streamableHttpProxy` +
// `setInitializeRequest`/`getInitializeRequest` helpers were deleted with
// the McpAgent surface. Phase 8 reinstalls a chat-native browser entry
// (apps/web → `useAgentChat` over `/agents/cmo/<userId>` WebSocket).
//
// Existing auth assertions in `cmo-routing.test.ts` (401 without bearer,
// 401 expired, 403 mismatched userId / scope) survive — the JWT validation
// happens here before the 503 dispatch.
// ──────────────────────────────────────────────────────────────────────────

async function handleMcpRequest(
  request: Request,
  env: Env,
  role: string,
  userId: string,
): Promise<Response> {
  if (role !== "cmo") {
    return new Response("role not exposed at /agents in Phase 1", {
      status: 404,
    });
  }

  // JWT validation. Bearer prefix → verify → claim.userId vs URL.userId.
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return new Response("unauthorized", { status: 401 });
  }
  let claims: Record<string, unknown>;
  try {
    claims = await verifyJwt(auth.slice(7), env.MCP_JWT_SECRET);
  } catch {
    return new Response("invalid token", { status: 401 });
  }
  if (claims["userId"] !== userId) {
    return new Response("token userId mismatch", { status: 403 });
  }
  // Scope-claim guard: historical cross-replay protection. The legacy
  // /api/cmo-ws-token route minted scope:'activity' tokens; it was
  // retired in Phase 10 of the CF-native chat migration. /api/mcp-token
  // continues to mint MCP-scoped (no `scope` claim today) tokens. We
  // accept undefined (back-compat) or 'mcp'.
  const scope = (claims as { scope?: unknown }).scope;
  if (scope !== undefined && scope !== "mcp") {
    return new Response("token scope not valid for mcp", { status: 403 });
  }

  // Past auth: the MCP transport is offline. Phase 8 will rewire to a
  // chat-native browser entry. Returning 503 (not 200) so old web builds
  // surface the migration state clearly instead of silently hanging.
  return new Response(
    "MCP transport retired in Phase 5; chat-native browser entry lands in Phase 8",
    { status: 503 },
  );
}

// ──────────────────────────────────────────────────────────────────────────
// /external/agents/<role>/<userId>/mcp  — Phase 2 external MCP entry
//
// Long-lived (30d) tokens signed with `EXTERNAL_MCP_SECRET`. Token claims
// must match the URL `<role>` and `<userId>` (or `role === "*"`).
//
// Per Phase 0 spike #3:
//   - `McpAgent.serve()` defaults its binding to `"MCP_OBJECT"` — we MUST
//     pass `{ binding: "<NAME>" }` explicitly. The binding name comes from
//     ROLE_REGISTRY[role].binding.
//   - The external HTTP path does NOT auto-populate `this.props`, so
//     per-tool scope gating is NOT implemented in P2-A. Scope is recorded
//     in the token (forward-compat) but currently grants URL-level access
//     (any tool on this role). Documented in /docs/mcp + /mcp-urls.
// ──────────────────────────────────────────────────────────────────────────
async function handleExternalMcpRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  role: string,
  userId: string,
): Promise<Response> {
  const token = await validateExternalAccess(request, env, userId, role);
  if (!token) {
    return new Response("unauthorized", { status: 401 });
  }

  if (!isValidRole(role)) {
    return new Response("unknown role", { status: 404 });
  }
  const entry = ROLE_REGISTRY[role as RoleSlug];
  if (!entry) {
    return new Response("role not exposed externally", { status: 404 });
  }

  // Task 5.1b: every employee class (CMO/HoG/SMM) is now AIChatAgent and
  // has no `.serve()` MCP shim. The external MCP surface is offline until
  // Phase 7 wires `withOAuthProvider` on the chat-native entry. Auth
  // still runs above so token-validation tests stay green.
  return new Response(
    "external MCP surface offline; Phase 7 reinstalls via withOAuthProvider",
    { status: 503 },
  );
}
