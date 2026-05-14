import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpProps } from "@shipflare/shared";
import type { Env } from "../../../index";
import { applyXSchema } from "./schema";

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
   * Tool registration lands in S5.1 (`x_search`, `x_post`, `x_metrics`).
   * S5.0 deliberately ships the class + schema only so SMM's cleanup
   * (`platformServerName` + the now-uncast `addMcpServer` dial) can land
   * without dragging in the platform SDK churn.
   */
  async init(): Promise<void> {
    // S5.1: registerXSearchTool(this);
    // S5.1: registerXPostTool(this);
    // S5.1: registerXMetricsTool(this);
  }
}
