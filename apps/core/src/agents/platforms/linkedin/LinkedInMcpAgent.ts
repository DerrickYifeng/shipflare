import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpProps } from "@shipflare/shared";
import type { Env } from "../../../index";
import { applyLinkedInSchema } from "./schema";
import { registerLinkedInSearchTool } from "./tools/linkedin-search";
import { registerLinkedInPostTool } from "./tools/linkedin-post";

interface LinkedInState {
  lastWakeAt: number;
}

/**
 * LinkedIn platform tool MCP — leaf tool surface (P2-E).
 *
 * Sibling of XMcpAgent / RedditMcpAgent. Like them, LinkedInMcpAgent has
 * NO sub-agent connections, NO Anthropic calls of its own, and NO opinion
 * on strategic_path or plan_items. Thin DO wrapping LinkedIn's UGC Posts
 * API with the standard 3-table cache (rate_limits / call_cache /
 * posted_externals).
 *
 * Tools:
 *   - linkedin_search — STUB (returns []); LinkedIn search requires
 *                       Marketing Developer Platform access.
 *   - linkedin_post   — real implementation against
 *                       https://api.linkedin.com/v2/ugcPosts.
 *
 * OAuth: the founder runs through `/api/channels/linkedin/connect` →
 * LinkedIn authorize → `/api/channels/linkedin/callback`. Token is
 * AES-GCM-encrypted and stored in `channels` D1; LinkedInMcpAgent reads
 * it back via `getChannel(env, userId, "linkedin")` (the only sanctioned
 * decrypt path; CLAUDE.md Security TODO §1).
 *
 * Migration tag: v8 (P2-E lands all three platforms — LinkedIn, HN,
 * Discord — together).
 */
export class LinkedInMcpAgent extends McpAgent<
  Env,
  LinkedInState,
  McpProps & { role?: "lead" | "member" }
> {
  server = new McpServer({
    name: "shipflare-linkedin-mcp",
    version: "1.0.0",
  });
  initialState: LinkedInState = { lastWakeAt: 0 };

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
    applyLinkedInSchema(this.ctx.storage.sql);
    this.setState({ ...this.state, lastWakeAt: Date.now() });
    await super.onStart(props);
  }

  async init(): Promise<void> {
    registerLinkedInSearchTool(this);
    registerLinkedInPostTool(this);
  }
}
