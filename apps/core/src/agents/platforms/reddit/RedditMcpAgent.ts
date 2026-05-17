import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpProps } from "@shipflare/shared";
import type { Env } from "../../../index";
import { applyRedditSchema } from "./schema";
import { registerRedditSearchTool, redditSearchImpl } from "./tools/reddit-search";
import { registerRedditPostTool } from "./tools/reddit-post";
import { registerResearchSubredditsTool, researchSubredditsImpl } from "./tools/research-subreddits";
import { registerRedditLocalMetricsTool, computeRedditLocalMetrics } from "./tools/reddit-local-metrics";

interface RedditState {
  lastWakeAt: number;
}

/**
 * Reddit platform tool MCP — leaf tool surface (sibling of XMcpAgent).
 *
 * Like X_MCP, RedditMcpAgent has NO sub-agent connections, NO Anthropic
 * calls of its own, and NO opinion on strategic_path or plan_items.
 * It's a thin DO that wraps Reddit's REST + public JSON API with:
 *   - per-endpoint rate-limit accounting (`rate_limits` table)
 *   - per-query response caching (`call_cache` table)
 *   - per-user posted history (`posted_externals` table)
 *
 * Two of Reddit's three tools (`reddit_search`, `research_subreddits`)
 * are ANONYMOUS — they hit Reddit's public `*.json` endpoints which
 * require only a non-empty `User-Agent` header. No OAuth token needed.
 * Only `reddit_post` (write) routes through `getChannel(env, userId,
 * "reddit")` and is role-gated to lead / external callers — same
 * publish boundary as XMcpAgent (`_shared/guards.ts`).
 *
 * Phase 1: the wrangler binding (REDDIT_MCP) + `Env.REDDIT_MCP` stay
 * commented until S5.3 lands migration tag v4 alongside X_MCP. The
 * class is re-exported from `src/index.ts` now so the module graph
 * reaches it for schema tests that borrow a CMO DO's SqlStorage.
 *
 * Per spec §4.3.1: extends McpAgent with the same `McpProps` shape
 * every other DO uses. `role?: "lead" | "member"` is included in the
 * props generic so external callers (e.g. SMM dialing REDDIT_MCP) can
 * pass a role hint without TypeScript widening.
 */
export class RedditMcpAgent extends McpAgent<
  Env,
  RedditState,
  McpProps & { role?: "lead" | "member" }
> {
  server = new McpServer({ name: "shipflare-reddit-mcp", version: "1.0.0" });
  initialState: RedditState = { lastWakeAt: 0 };
  private _toolsRegistered = false;

  /**
   * Narrow accessors so tool-registration modules (which live outside
   * the class and therefore can't see `protected` DurableObject
   * members) can reach the raw SQL storage and Worker env. Same
   * pattern as XMcpAgent. `sqlStorage` instead of `sql` because the
   * parent `Agent` class already exposes a `sql` template-tag method;
   * `bindings` instead of `env` because `env` is a protected
   * DurableObject member.
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
    //  (b) schema-bootstrap tests can drive this method directly
    //      without faking a transport.
    applyRedditSchema(this.ctx.storage.sql);
    this.setState({ ...this.state, lastWakeAt: Date.now() });
    // Parent McpAgent.onStart() sets up the MCP transport. Must run
    // after schema bootstrap so any tool handlers registered in init()
    // can rely on the tables being there.
    await super.onStart(props);
  }

  /**
   * Tool registration. Three tools, one per concrete Reddit API
   * surface:
   *   - reddit_search       — read via Reddit's public JSON API
   *                           (anonymous; no OAuth needed)
   *   - reddit_post         — write (submission OR comment), role-gated
   *                           to lead/external (OAuth via getChannel)
   *   - research_subreddits — read via Reddit's subreddit-search
   *                           public JSON API (anonymous; ranks by
   *                           subscriber count as ICP-fit proxy)
   */
  async init(): Promise<void> {
    if (this._toolsRegistered) return;
    this._toolsRegistered = true;
    registerRedditSearchTool(this);
    registerRedditPostTool(this);
    registerResearchSubredditsTool(this);
    registerRedditLocalMetricsTool(this);
  }

  /**
   * Route `/internal/*` requests. All endpoints are gated on
   * `x-shipflare-internal: 1` (set by the cron worker; Cloudflare strips
   * this header from public-edge traffic).
   *
   * `/internal/reddit_local_metrics` — called by the growth-snapshot cron
   * to read local posted_externals counts for this user without going
   * through the MCP protocol layer.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const internal = request.headers.get("x-shipflare-internal") === "1";
    if (!internal && url.pathname.startsWith("/internal/")) {
      return new Response("forbidden", { status: 403 });
    }
    if (url.pathname === "/internal/reddit_local_metrics") {
      try {
        const metrics = computeRedditLocalMetrics(this);
        return new Response(JSON.stringify(metrics), {
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          "[RedditMcpAgent] /internal/reddit_local_metrics failed:",
          msg,
        );
        return new Response(JSON.stringify({ error: msg }), { status: 500 });
      }
    }
    if (url.pathname === "/internal/reddit_search") {
      try {
        const body = (await request.json()) as {
          product: string;
          productDescription?: string;
          intent?: string;
          maxResults?: number;
          subreddit?: string;
        };
        const results = await redditSearchImpl(body);
        return new Response(JSON.stringify(results), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          "[RedditMcpAgent] /internal/reddit_search failed:",
          msg,
        );
        return new Response(JSON.stringify({ error: msg }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }
    if (url.pathname === "/internal/research_subreddits") {
      try {
        const body = (await request.json()) as {
          product: string;
          audience?: string;
          productDescription?: string;
        };
        const results = await researchSubredditsImpl(body);
        return new Response(JSON.stringify(results), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          "[RedditMcpAgent] /internal/research_subreddits failed:",
          msg,
        );
        return new Response(JSON.stringify({ error: msg }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return super.fetch(request);
  }
}
