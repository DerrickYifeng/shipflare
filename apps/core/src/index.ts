/**
 * @shipflare/core — DO host Worker entry.
 *
 * Phase 1 scaffold. The actual McpAgent DO classes (CMO, HoG, SMM,
 * X / Reddit tool MCPs) come online in S2-S5. The AgentPlanWorkflow lands
 * with S6. For now this file:
 *
 * - serves `/healthz`
 * - stubs `/agents/<role>/<userId>/mcp` and
 *   `/agents/<role>/<userId>/internal/<...>` so the routing contract is
 *   visible (returns 501 with a pointer to the wiring task)
 * - stubs `scheduled()` for the hourly inbound-sweep cron
 *
 * DO/Workflow bindings are commented out in wrangler.jsonc until their
 * class declarations land — adding a binding before its class compiles is
 * a wrangler dev startup error.
 */

import type { CMO } from "./agents/cmo/CMO";

// Value re-export so wrangler can discover the DO class via the module
// graph rooted at `main`. Per Phase 0 spike #2 the import-then-export
// shape is required: `export { CMO } from "..."` alone has tripped
// wrangler's class-name resolver in some setups.
export { CMO } from "./agents/cmo/CMO";

export interface Env {
  DB: D1Database;
  // DO bindings — uncomment as classes come online (S2-S5).
  // Per Phase 0 spike #2: parameterized `DurableObjectNamespace<CMO>` is
  // required (not bare) for `addMcpServer`'s generic constraint to resolve.
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

/** Matches `/agents/<role>/<userId>/mcp[/...]` — used by the browser MCP client. */
const MCP_ROUTE = /^\/agents\/([a-z-]+)\/([^/]+)\/mcp(?:\/|$)/;

/** Matches `/agents/<role>/<userId>/internal/<...>` — used by sibling agents (DO → DO over fetch). */
const INTERNAL_ROUTE = /^\/agents\/([a-z-]+)\/([^/]+)\/internal\//;

export default {
  async fetch(
    request: Request,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, ts: Date.now() });
    }

    if (MCP_ROUTE.test(url.pathname)) {
      // Wired in S2.6: validate Authorization Bearer JWT, derive
      // (role, userId), look up the DO namespace from ROLE_REGISTRY, and
      // forward to McpAgent.serve('/agents/:role/:userId/mcp', { binding }).
      return new Response("MCP routing not wired yet — see S2.6", {
        status: 501,
      });
    }

    if (INTERNAL_ROUTE.test(url.pathname)) {
      // Wired in S2.6: shared-secret-authenticated routes for sibling-agent
      // RPC (CMO → HoG, HoG → SMM, etc.) over the DO fetch boundary.
      return new Response("internal routing not wired yet — see S2.6", {
        status: 501,
      });
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(
    _event: ScheduledController,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // Hourly fan-out to active CMOs for inbound sweep — wired in S2.6 / S6.
    // Implementation will query D1 for users with `defaultActive` CMOs and
    // dispatch a `tick` message to each via the CMO DO binding.
  },
} satisfies ExportedHandler<Env>;
