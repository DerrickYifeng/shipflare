import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpProps } from "@shipflare/shared";
import type { Env } from "../../../index";
import { applyXSchema } from "./schema";
import { registerXSearchTool, xSearchImpl } from "./tools/x-search";
import { registerXPostTool } from "./tools/x-post";
import { registerXMetricsTool } from "./tools/x-metrics";
import { registerXAggregateMetricsTool, computeXAggregateMetrics } from "./tools/x-aggregate-metrics";

interface XState {
  lastWakeAt: number;
}

/**
 * X platform tool MCP — leaf tool surface.
 *
 * Unlike CMO / HoG / SMM (employee DOs with LLM autonomy), XMcpAgent has
 * NO sub-agent connections, NO Anthropic calls of its own, and NO opinion on
 * strategic_path or plan_items. It's a thin DO that wraps X's REST API with:
 *   - per-user rate-limit accounting (`rate_limits` table)
 *   - per-user response caching (`call_cache` table)
 *   - per-user posted history (`posted_externals` table)
 *
 * The OAuth token lookup happens via `apps/core/src/lib/channel.ts`'s
 * `getChannel(env, userId, 'x')` — the sanctioned token reader. XMcpAgent
 * MUST NOT touch the encrypted columns of `channels` D1 directly.
 *
 * Tools land in S5.1 (`x_search`, `x_post`, `x_metrics`). The wrangler
 * binding stays commented until S5.3 — adding it requires a new migration
 * tag (v4) along with RedditMcpAgent.
 *
 * Per spec §4.3.1: extends McpAgent with the same `McpProps` shape every
 * other DO uses. The `role?: "lead" | "member"` is included in the props
 * generic so external callers (e.g. SMM dialing X_MCP) can pass a role hint
 * without TypeScript widening; in practice X_MCP doesn't differentiate
 * caller role.
 */
export class XMcpAgent extends McpAgent<
  Env,
  XState,
  McpProps & { role?: "lead" | "member" }
> {
  server = new McpServer({ name: "shipflare-x-mcp", version: "1.0.0" });
  initialState: XState = { lastWakeAt: 0 };
  private _toolsRegistered = false;

  /**
   * Narrow accessors so tool-registration modules (which live outside the
   * class and therefore can't see `protected` DurableObject members) can
   * reach the raw SQL storage and Worker env. Same pattern as CMO/HoG/SMM
   * (S2.1 / S3.0 / S4.0). `sqlStorage` instead of `sql` because the parent
   * `Agent` class already exposes a `sql` template-tag method; `bindings`
   * instead of `env` because `env` is a protected DurableObject member.
   */
  get sqlStorage(): SqlStorage {
    return this.ctx.storage.sql;
  }
  get bindings(): Env {
    return this.env;
  }

  async onStart(props?: McpProps): Promise<void> {
    // Schema bootstrap runs BEFORE `super.onStart()` so that
    //  (a) our tables exist even if the parent's transport-init throws
    //      (non-transport-named DOs fail in `getTransportType()`), and
    //  (b) schema-bootstrap tests can drive this method directly without
    //      faking a transport.
    applyXSchema(this.ctx.storage.sql);
    this.setState({ ...this.state, lastWakeAt: Date.now() });
    // Parent McpAgent.onStart() sets up the MCP transport. Must run after
    // schema bootstrap so any tool handlers registered in init() can rely
    // on the tables being there.
    await super.onStart(props);
  }

  /**
   * Tool registration. Three tools, one per concrete X API surface:
   *   - x_search  — read via xAI Grok (env.XAI_API_KEY, no OAuth)
   *   - x_post    — write, role-gated to lead/external (OAuth via getChannel)
   *   - x_metrics — read, OAuth-required (any role) (OAuth via getChannel)
   */
  async init(): Promise<void> {
    if (this._toolsRegistered) return;
    this._toolsRegistered = true;
    registerXSearchTool(this);
    registerXPostTool(this);
    registerXMetricsTool(this);
    registerXAggregateMetricsTool(this);
  }

  /**
   * Route `/internal/*` requests. All endpoints are gated on
   * `x-shipflare-internal: 1` (set by the cron worker; Cloudflare strips
   * this header from public-edge traffic).
   *
   * `/internal/x_aggregate_metrics` — called by the growth-snapshot cron
   * to fetch real X engagement metrics for this user without going through
   * the MCP protocol layer.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const internal = request.headers.get("x-shipflare-internal") === "1";
    if (!internal && url.pathname.startsWith("/internal/")) {
      return new Response("forbidden", { status: 403 });
    }
    if (url.pathname === "/internal/x_aggregate_metrics") {
      try {
        const metrics = await computeXAggregateMetrics(this, 30);
        return new Response(JSON.stringify(metrics), {
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[XMcpAgent] /internal/x_aggregate_metrics failed:", msg);
        return new Response(JSON.stringify({ error: msg }), { status: 500 });
      }
    }
    if (url.pathname === "/internal/x_search") {
      try {
        const body = (await request.json()) as {
          product: string;
          productDescription?: string;
          intent?: string;
          maxResults?: number;
        };
        const results = await xSearchImpl(this.env, body);
        return new Response(JSON.stringify(results), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[XMcpAgent] /internal/x_search failed:", msg);
        return new Response(JSON.stringify({ error: msg }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return super.fetch(request);
  }
}
