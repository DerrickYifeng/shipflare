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

import { verifyJwt } from "./lib/jwt";
import { validateExternalAccess } from "./lib/external-auth";
import { ROLE_REGISTRY, isValidRole, type RoleSlug } from "@shipflare/shared";
import { createDb, user as userTable } from "@shipflare/db";

import { CMO } from "./agents/cmo/CMO";
import { HeadOfGrowth } from "./agents/head-of-growth/HeadOfGrowth";
import { SocialMediaMgr } from "./agents/social-media-manager/SocialMediaMgr";
// P2-B — Phase 2 Pro-tier opt-in roster. Imported as values so they can
// register in the EMPLOYEE_CLASSES dispatch table and be re-exported below
// for wrangler module-graph discovery (v5/v6/v7 migrations).
import { Copywriter } from "./agents/copywriter/Copywriter";
import { BrandAnalyst } from "./agents/brand-analyst/BrandAnalyst";
import { CommunityManager } from "./agents/community-manager/CommunityManager";
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
export { Copywriter, BrandAnalyst, CommunityManager };
// Re-export the platform DO classes so wrangler can discover them; the
// bindings in wrangler.jsonc + the Env entries below stay COMMENTED until
// S5.3 wires migration tag v4. Re-exporting the classes now keeps the
// import graph reachable for schema tests that getByName-cast another
// binding.
export { XMcpAgent } from "./agents/platforms/x/XMcpAgent";
export { RedditMcpAgent } from "./agents/platforms/reddit/RedditMcpAgent";

export interface Env {
  DB: D1Database;
  // DO bindings — uncomment as classes come online (S2-S5).
  CMO: DurableObjectNamespace<CMO>;
  HEAD_OF_GROWTH: DurableObjectNamespace<HeadOfGrowth>; // S3
  SOCIAL_MEDIA_MGR: DurableObjectNamespace<SocialMediaMgr>; // S4
  X_MCP: DurableObjectNamespace<XMcpAgent>; // S5.3 — migration tag v4
  REDDIT_MCP: DurableObjectNamespace<RedditMcpAgent>; // S5.3 — migration tag v4
  COPYWRITER: DurableObjectNamespace<Copywriter>; // P2-B — migration tag v5
  BRAND_ANALYST: DurableObjectNamespace<BrandAnalyst>; // P2-B — migration tag v6
  COMMUNITY_MGR: DurableObjectNamespace<CommunityManager>; // P2-B — migration tag v7
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
  // P2-B — Phase 2 expanded roster
  copywriter: Copywriter,
  "brand-analyst": BrandAnalyst,
  "community-manager": CommunityManager,
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

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, ts: Date.now() });
    }

    // External MCP route MUST match BEFORE the Phase 1 `/agents/...` route.
    // The Phase 1 MCP_ROUTE regex (`/^\/agents\/.../`) would never see
    // `/external/agents/...` anyway (it's anchored at the start), but we
    // run the external check first for clarity + to short-circuit a
    // potentially-expensive DO spin-up if the JWT is bad.
    const externalMatch = EXTERNAL_MCP_ROUTE.exec(url.pathname);
    if (externalMatch) {
      const [, role, userId] = externalMatch;
      return handleExternalMcpRequest(request, env, ctx, role!, userId!);
    }

    const internalMatch = INTERNAL_ROUTE.exec(url.pathname);
    if (internalMatch) {
      const [, role, userId, internalPath] = internalMatch;
      return handleInternalRequest(
        request,
        env,
        role!,
        userId!,
        internalPath!,
      );
    }

    const mcpMatch = MCP_ROUTE.exec(url.pathname);
    if (mcpMatch) {
      const [, role, userId] = mcpMatch;
      return handleMcpRequest(request, env, role!, userId!);
    }

    return new Response("not found", { status: 404 });
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
          const stub = env.CMO.get(env.CMO.idFromName(userId));
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
  },
} satisfies ExportedHandler<Env>;

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
  const stub = ns.get(ns.idFromName(userId));

  // Strip the public path prefix — the DO's fetch handler expects
  // `/internal/<path>`, not `/agents/<role>/<userId>/internal/<path>`.
  return stub.fetch(new Request(`https://internal${internalPath}`, request));
}

// ──────────────────────────────────────────────────────────────────────────
// /agents/<role>/<userId>/mcp
// External MCP entry. JWT-protected. Token must carry `{ userId }` matching
// the URL.
//
// Phase 1: only `cmo` is exposed externally (founder UI → CMO). Other roles
// (Head of Growth, Social Media Manager) ride along on the CMO's
// `addMcpServer` in-process pipe and are unreachable from /agents/<role>.
// Phase 2 will open a separate `/external/agents/...` prefix with stricter
// scope checks.
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

  // Forward to the CMO DO. The DO's McpAgent transport handles JSON-RPC
  // framing, session id, etc.
  const stub = env.CMO.get(env.CMO.idFromName(userId));
  return stub.fetch(request);
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
