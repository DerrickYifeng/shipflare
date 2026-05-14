/**
 * @shipflare/core — DO host Worker entry.
 *
 * S2.6 wires the real routing:
 *
 * - `/healthz` → quick liveness probe
 * - `/agents/<role>/<userId>/mcp[/...]` → external MCP entry. JWT-protected
 *   (HS256, signed by `apps/web` via `MCP_JWT_SECRET`). Phase 1 only exposes
 *   `cmo`; HoG / SMM ride along on the CMO's `addMcpServer` in-process pipe.
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
import { ROLE_REGISTRY, isValidRole, type RoleSlug } from "@shipflare/shared";
import { createDb, user as userTable } from "@shipflare/db";

import type { CMO } from "./agents/cmo/CMO";

// Value re-export so wrangler can discover the DO class via the module
// graph rooted at `main`.
export { CMO } from "./agents/cmo/CMO";

export interface Env {
  DB: D1Database;
  // DO bindings — uncomment as classes come online (S2-S5).
  CMO: DurableObjectNamespace<CMO>;
  // HEAD_OF_GROWTH: DurableObjectNamespace;     // S3
  // SOCIAL_MEDIA_MGR: DurableObjectNamespace;   // S4
  // X_MCP: DurableObjectNamespace;              // S5
  // REDDIT_MCP: DurableObjectNamespace;         // S5
  // Workflow binding — added when AgentPlanWorkflow lands (S6).
  // AGENT_PLAN_WORKFLOW: Workflow;
  // Secrets (wrangler secret put ...)
  ANTHROPIC_API_KEY: string;
  XAI_API_KEY: string;
  MCP_JWT_SECRET: string;
  CHANNEL_ENC_KEY: string;
}

/**
 * `/agents/<role>/<userId>/mcp[/...]` — external MCP entry. The trailing
 * `(?:\/|$)` covers BOTH the initial handshake POST to `/mcp` and any
 * subsequent McpAgent sub-paths (e.g. `/mcp/messages`).
 */
const MCP_ROUTE = /^\/agents\/([a-z-]+)\/([^/]+)\/mcp(?:\/|$)/;

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
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, ts: Date.now() });
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
