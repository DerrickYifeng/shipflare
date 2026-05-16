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
 * - `scheduled()` → hourly fan-out. Iterates `user` rows in D1, POSTs
 *   `/internal/cron-tick` to each user's CMO DO. Per-DO failures are
 *   isolated via `Promise.allSettled`.
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

import { getAgentByName } from "agents";
import { handleOnboardingInternal } from "./onboarding-routes";
import { verifyJwt } from "./lib/jwt";
import { validateExternalAccess } from "./lib/external-auth";
import { transportName } from "./lib/do-name";
import { ROLE_REGISTRY, isValidRole, type RoleSlug } from "@shipflare/shared";
import {
  createDb,
  user as userTable,
  channels as channelsTable,
  growthSnapshots as growthSnapshotsTable,
} from "@shipflare/db";

import { CMO } from "./agents/cmo/CMO";
import { HeadOfGrowth } from "./agents/head-of-growth/HeadOfGrowth";
import { SocialMediaMgr } from "./agents/social-media-manager/SocialMediaMgr";
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
export { CMO, HeadOfGrowth, SocialMediaMgr };
// Re-export the platform DO classes so wrangler can discover them via the
// module graph rooted at `main`.
export { XMcpAgent } from "./agents/platforms/x/XMcpAgent";
export { RedditMcpAgent } from "./agents/platforms/reddit/RedditMcpAgent";

export interface Env {
  DB: D1Database;
  // DO bindings — 3 employee agents + 2 platform tool MCPs.
  CMO: DurableObjectNamespace<CMO>;
  HEAD_OF_GROWTH: DurableObjectNamespace<HeadOfGrowth>;
  SOCIAL_MEDIA_MGR: DurableObjectNamespace<SocialMediaMgr>;
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
}

/**
 * Class dispatch table for the Phase 2 external MCP route. Maps the URL
 * `<role>` segment to the McpAgent subclass we use for `Klass.serve(...)`.
 *
 * Keep in sync with `ROLE_REGISTRY` (`@shipflare/shared`): every role with
 * an `externalExposed` capability needs an entry here. P2-B additions get
 * added here when they land — adding a row in `ROLE_REGISTRY` alone is not
 * enough to expose a new role externally.
 *
 * Typed as `Record<string, typeof McpAgent>` would require fighting the
 * generic params on McpAgent<Env, State, Props>. The use-site only calls
 * `.serve(path, { binding }).fetch(...)`, which all three classes inherit
 * unchanged from `McpAgent`. `any` here is bounded: the dispatch is gated
 * by `validateExternalAccess` (auth) + the URL-pattern check above, and
 * the runtime types come from the McpAgent base class.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const EMPLOYEE_CLASSES: Record<string, any> = {
  cmo: CMO,
  "head-of-growth": HeadOfGrowth,
  "social-media-manager": SocialMediaMgr,
};

/**
 * `/agents/<role>/<userId>/mcp[/...]` — Phase 1 internal MCP entry. The
 * trailing `(?:\/|$)` covers BOTH the initial handshake POST to `/mcp` and
 * any subsequent McpAgent sub-paths (e.g. `/mcp/messages`).
 */
const MCP_ROUTE = /^\/agents\/([a-z-]+)\/([^/]+)\/mcp(?:\/|$)/;

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

/**
 * Per-tick cap on D1 user fan-out. We're early in Phase 1 — every active CMO
 * gets ticked every hour regardless of activity. The cap prevents a runaway
 * cron call when the user table grows faster than the per-user activity
 * gating ships. Remove this once `user.lastActiveAt`-based filtering exists.
 */
const CRON_FANOUT_CAP = 1000;

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
    // Hourly fan-out. Read every user.id from D1, fire `/internal/cron-tick`
    // at their CMO DO. Each tick is a separate DO instance so failures
    // isolate — one bad CMO doesn't block the rest.
    //
    // Phase 0 spike #9: don't use `SELF.scheduled()` to test this; call
    // the handler directly from tests instead.
    try {
      const db = createDb(env.DB);
      const users = await db.select({ id: userTable.id }).from(userTable);
      const subset = users.slice(0, CRON_FANOUT_CAP);
      await Promise.allSettled(
        subset.map(({ id: userId }) => {
          const stub = env.CMO.get(env.CMO.idFromName(transportName(userId)));
          return stub.fetch(
            new Request("https://internal/internal/cron-tick", {
              method: "POST",
              headers: { "x-shipflare-internal": "1" },
            }),
          );
        }),
      );
    } catch (err) {
      // Cron should be self-healing — log + swallow. The next tick retries.
      console.error("[scheduled] cron fan-out failed:", err);
    }

    // Growth snapshots: capture per-(user, platform) metrics into D1 every
    // 6h tick. Phase 1 stores empty metrics {}; a later task wires real
    // collection. Per-(user, platform) failures are isolated via the
    // try/catch inside snapshotGrowth.
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
    return handleOnboardingInternal(request, env, url);
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

  return new Response("not found", { status: 404 });
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
// JWT-protected internal MCP entry for the browser → CMO DO path.
//
// The Agents SDK (agents@0.12.4) does NOT support plain HTTP forwarding to
// a DO. `McpAgent.serve()` internally wraps `createStreamingHttpHandler`
// which converts HTTP POST/GET requests into WebSocket upgrades with custom
// Cloudflare headers (`cf-mcp-method`, `cf-mcp-message`) before calling
// agent.fetch(). Bypassing that with a bare stub.fetch(request) results in
// "Not implemented".
//
// We implement `streamableHttpProxy` — the same Worker→DO protocol as
// `createStreamingHttpHandler`, but keying the DO by `userId` instead of a
// random sessionId. This gives a stable per-user CMO DO (persistent SQLite
// state across browser sessions), which the random-session approach can't.
// ──────────────────────────────────────────────────────────────────────────

// Custom MCP header names used by the Agents SDK (agents@0.12.4 source).
const CF_MCP_METHOD = "cf-mcp-method";
const CF_MCP_MESSAGE = "cf-mcp-message";

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

  return streamableHttpProxy(request, env.CMO, userId, { userId });
}

/**
 * Implements the Agents SDK's Worker→DO streamable HTTP protocol, keyed by
 * userId for stable per-user DO instances.
 *
 * The SDK's createStreamingHttpHandler (not exported) converts browser HTTP
 * POST/GET into a WebSocket upgrade with `cf-mcp-method` + `cf-mcp-message`
 * headers, calls agent.fetch(), then streams WebSocket messages back as SSE.
 * We replicate that here, substituting userId for the random sessionId so
 * all of the founder's browser sessions share one CMO DO (and its SQLite).
 */
async function streamableHttpProxy(
  request: Request,
  namespace: DurableObjectNamespace<CMO>,
  userId: string,
  props: Record<string, unknown>,
): Promise<Response> {
  const method = request.method.toUpperCase();

  if (method === "POST") {
    const accept = request.headers.get("accept") ?? "";
    const ct = request.headers.get("content-type") ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      return mcpJsonError(-32000, "Not Acceptable: must accept application/json and text/event-stream", 406);
    }
    if (!ct.includes("application/json")) {
      return mcpJsonError(-32000, "Unsupported Media Type: Content-Type must be application/json", 415);
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return mcpJsonError(-32700, "Parse error: Invalid JSON", 400);
    }
    const messages = Array.isArray(raw) ? raw : [raw];

    const agent = await getAgentByName(namespace, transportName(userId), { props });

    const isInit = messages.some(
      (m): boolean =>
        typeof m === "object" && m !== null && (m as Record<string, unknown>)["method"] === "initialize",
    );
    if (isInit) {
      await agent.setInitializeRequest(messages[0]);
    } else if (!(await agent.getInitializeRequest())) {
      return mcpJsonError(-32001, "Session not found", 404);
    }

    const fwd: Record<string, string> = {};
    request.headers.forEach((v, k) => { fwd[k] = v; });

    const wsRes = await agent.fetch(
      new Request(request.url, {
        headers: {
          ...fwd,
          [CF_MCP_METHOD]: "POST",
          [CF_MCP_MESSAGE]: Buffer.from(JSON.stringify(messages)).toString("base64"),
          Upgrade: "websocket",
        },
      }),
    );
    return sseFromWebSocket(wsRes.webSocket, userId);
  }

  if (method === "GET") {
    const agent = await getAgentByName(namespace, transportName(userId), { props });
    const fwd: Record<string, string> = {};
    request.headers.forEach((v, k) => { fwd[k] = v; });
    const wsRes = await agent.fetch(
      new Request(request.url, {
        headers: { ...fwd, [CF_MCP_METHOD]: "GET", Upgrade: "websocket" },
      }),
    );
    return sseFromWebSocket(wsRes.webSocket, userId);
  }

  if (method === "DELETE") {
    const agent = await getAgentByName(namespace, transportName(userId), { props });
    const fwd: Record<string, string> = {};
    request.headers.forEach((v, k) => { fwd[k] = v; });
    await agent.fetch(
      new Request(request.url, {
        headers: { ...fwd, [CF_MCP_METHOD]: "DELETE", Upgrade: "websocket" },
      }),
    );
    return new Response(null, { status: 200 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

function sseFromWebSocket(ws: WebSocket | null, sessionId: string): Response {
  if (!ws) return mcpJsonError(-32001, "Failed to establish WebSocket connection to DO", 500);
  ws.accept();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  ws.addEventListener("message", (event) => {
    // The DO sends messages as: { type: "cf_mcp_agent_event", event: "<sse-string>", close?: true }
    // `event` is already SSE-formatted ("data: ...\n\n") — write it directly.
    // Ignore non-MCP messages (e.g. internal DO keepalives).
    async function onMessage(ev: MessageEvent) {
      try {
        const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        const msg = JSON.parse(raw) as { type?: string; event?: string; close?: boolean };
        if (msg.type !== "cf_mcp_agent_event") return;
        if (msg.event) await writer.write(enc.encode(msg.event));
        if (msg.close) {
          ws?.close();
          await writer.close().catch(() => {});
        }
      } catch (err) {
        console.error("[sseFromWebSocket] message parse error:", err);
      }
    }
    void onMessage(event);
  });
  ws.addEventListener("close", () => void writer.close().catch(() => {}));
  ws.addEventListener("error", () => void writer.close().catch(() => {}));
  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "mcp-session-id": sessionId,
      "cache-control": "no-cache",
    },
  });
}

function mcpJsonError(code: number, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }),
    { status, headers: { "content-type": "application/json" } },
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
  ctx: ExecutionContext,
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
  const Klass = EMPLOYEE_CLASSES[role];
  const entry = ROLE_REGISTRY[role as RoleSlug];
  if (!Klass || !entry) {
    return new Response("role not exposed externally", { status: 404 });
  }
  const binding = entry.binding;
  // Defensive: ensure the named binding actually exists on `env`. If the
  // DO class is declared in ROLE_REGISTRY + EMPLOYEE_CLASSES but the
  // wrangler binding isn't deployed yet, fail loud with 503.
  const ns = (env as unknown as Record<string, unknown>)[binding];
  if (!ns) {
    return new Response(`binding "${binding}" not deployed`, { status: 503 });
  }

  // Per Phase 0 spike #3: pass `binding` explicitly. The path pattern uses
  // `:userId` so the MCP SDK can extract the per-tenant DO id from the URL.
  return Klass.serve(`/external/agents/${role}/:userId/mcp`, {
    binding,
  }).fetch(request, env, ctx);
}
