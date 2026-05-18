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
 * - `/cmo/mcp`, `/authorize`, `/oauth/*`, `/.well-known/oauth-*` → Phase 7
 *   external MCP entry for 3rd-party MCP clients (Claude Desktop, Cursor,
 *   the founder's own LLM stack). Fronted by
 *   `@cloudflare/workers-oauth-provider` (OAuth 2.1 + PKCE + RFC 7591 DCR).
 *   The provider mints encrypted, refreshable tokens carrying
 *   `{ userId, scopes }` props that surface on `CmoExternalMcp.this.props`.
 *   Auth code → token exchange runs end-to-end via the provider; only
 *   `/authorize` requires an interactive ShipFlare login (Phase 7.5).
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

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import { handleOnboardingInternal } from "./onboarding-routes";
import { verifyJwt } from "./lib/jwt";
import { transportName } from "./lib/do-name";
import { inferTimezone } from "./lib/tz-inference";
import { ROLE_REGISTRY, isValidRole, type RoleSlug } from "@shipflare/shared";
import { CmoExternalMcp } from "./external/CmoExternalMcp";
import { ExternalAuthHandler } from "./external/auth-handler";
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
// Phase 7 — external MCP surface (chat-only, OAuth-scoped, per-user DO).
// Mounted via `@cloudflare/workers-oauth-provider` at `/cmo/mcp` (Task 7.3).
// The OAuth provider sits in front of the DO and populates `this.props =
// { userId, scopes }` after a successful PKCE flow; see
// `apps/core/src/external/auth-handler.ts` for the `/authorize` consent screen.
export { CmoExternalMcp };

export interface Env {
  DB: D1Database;
  // DO bindings — 3 employee agents + 2 platform tool MCPs + 1 external MCP.
  CMO: DurableObjectNamespace<CMO>;
  HOG: DurableObjectNamespace<HoG>;
  SMM: DurableObjectNamespace<SMM>;
  X_MCP: DurableObjectNamespace<XMcpAgent>;
  REDDIT_MCP: DurableObjectNamespace<RedditMcpAgent>;
  /**
   * Phase 7 — per-user external MCP surface (chat-only, OAuth-scoped). Each
   * user gets a SQLite-backed DO instance keyed by their userId. Exposed at
   * mcp.shipflare.com/cmo via `@cloudflare/workers-oauth-provider`.
   */
  CMO_EXTERNAL_MCP: DurableObjectNamespace<CmoExternalMcp>;
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
   * Phase 7 — KV namespace for `@cloudflare/workers-oauth-provider`. Stores
   * OAuth 2.1 client registrations, authorization codes, refresh tokens, and
   * access-token metadata for the mcp.shipflare.com/cmo external surface.
   */
  OAUTH_KV: KVNamespace;
  /**
   * Phase 7 — `@cloudflare/workers-oauth-provider` lazily attaches its helper
   * surface (`parseAuthRequest`, `lookupClient`, `completeAuthorization`,
   * `createClient`, ...) to `env.OAUTH_PROVIDER` right before invoking the
   * default handler. The auth-handler reads it from `env`, so the type is
   * declared here even though wrangler doesn't bind it directly.
   *
   * Optional because the binding is only present once the OAuthProvider's
   * fetch handler has dispatched into the default handler — for routes that
   * never enter the provider (e.g. /healthz) it stays undefined.
   */
  OAUTH_PROVIDER?: OAuthHelpers;
  /**
   * Phase 7.3 security gate (mirrors `STRATEGIC_PATH_FIXTURE`). When `"1"`,
   * `apps/core/src/external/auth-handler.ts` honors the `x-test-user-id`
   * header on `/authorize` POST so the auth-handler tests can complete the
   * OAuth grant without standing up a Better Auth session.
   *
   * MUST remain absent from `apps/core/wrangler.jsonc`. Set ONLY in
   * `apps/core/vitest.config.mts` under `miniflare.bindings`. If it ever
   * leaks into prod, any caller can mint an OAuth code for any victim's
   * userId (PKCE only proves same-client; it doesn't authenticate the
   * user). Phase 7.5 retires this seam once Better Auth verification is
   * wired in.
   */
  EXTERNAL_AUTH_TEST_SEAM?: string;
}

// Task 7.3 retired the legacy `/external/agents/<role>/<userId>/mcp` 503
// stub and the EMPLOYEE_CLASSES dispatch table that fed it. The new
// external surface lives at `/cmo/mcp` behind
// `@cloudflare/workers-oauth-provider` — wired in the main fetch handler
// below. `CmoExternalMcp` is the McpAgent class mounted as the provider's
// only apiHandler; `ExternalAuthHandler` renders the `/authorize` consent
// screen and completes grants.

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

// Task 7.3: `/external/agents/<role>/<userId>/mcp` and its `EXTERNAL_MCP_ROUTE`
// regex were retired. The external MCP surface now lives at `/cmo/mcp`
// behind `@cloudflare/workers-oauth-provider` — wired in the main fetch()
// handler above. `EXTERNAL_MCP_SECRET` lingers in Env for the legacy
// `validateExternalAccess` helper but no live route consumes it.

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

    // Phase 7 — external MCP surface mounted at `/cmo/mcp` behind OAuth 2.1
    // (PKCE + DCR). Any path the OAuthProvider owns is dispatched to it
    // BEFORE the existing ShipFlare routes so the well-known endpoints,
    // /authorize consent UI, /oauth/* token endpoints, and the protected
    // /cmo/mcp resource handler all live behind one provider instance.
    //
    // The provider attaches `env.OAUTH_PROVIDER` lazily on its way to the
    // default handler — `ExternalAuthHandler` then calls
    // `env.OAUTH_PROVIDER.completeAuthorization(...)` to mint the code +
    // redirect. Props (`{ userId, scopes }`) flow from there into the
    // verified-Bearer request that hits `CmoExternalMcp.serve("/cmo/mcp")`.
    if (
      url.pathname.startsWith("/cmo/mcp") ||
      url.pathname === "/authorize" ||
      url.pathname.startsWith("/oauth/") ||
      url.pathname.startsWith("/.well-known/oauth-")
    ) {
      const oauth = new OAuthProvider({
        apiHandlers: {
          "/cmo/mcp": CmoExternalMcp.serve("/cmo/mcp", {
            binding: "CMO_EXTERNAL_MCP",
          }) as unknown as ExportedHandler<Env> & {
            fetch: NonNullable<ExportedHandler<Env>["fetch"]>;
          },
        },
        defaultHandler: ExternalAuthHandler,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/oauth/token",
        clientRegistrationEndpoint: "/oauth/register",
        scopesSupported: ["cmo:chat"],
        accessTokenTTL: 3600,
        // 30 days in seconds — matches the long-lived TTL of the prior
        // EXTERNAL_MCP_SECRET-signed JWTs so the operational story
        // ("re-auth Claude Desktop monthly") doesn't change.
        refreshTokenTTL: 60 * 60 * 24 * 30,
        allowImplicitFlow: false,
        allowPlainPKCE: false,
        // D4: public DCR is enabled — Claude Desktop / mcp-remote /
        // Cursor self-register as public PKCE clients without a secret.
        disallowPublicClientRegistration: false,
      });
      const oauthRes = await oauth.fetch(request, env, ctx);
      return withCorsHeaders(oauthRes, cors);
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

// Task 7.3 (CF-native external MCP): the legacy
// `/external/agents/<role>/<userId>/mcp` 503 stub + `handleExternalMcpRequest`
// were removed in favour of the Phase 7 `@cloudflare/workers-oauth-provider`
// mount at `/cmo/mcp`. The new surface is wired in the main `fetch()` handler
// above; the auth gate is OAuth 2.1 PKCE, not an HS256 EXTERNAL_MCP_SECRET.
