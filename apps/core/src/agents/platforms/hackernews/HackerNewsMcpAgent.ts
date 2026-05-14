import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpProps } from "@shipflare/shared";
import type { Env } from "../../../index";
import { applyHackerNewsSchema } from "./schema";
import { registerHackerNewsSearchTool } from "./tools/hn-search";

interface HackerNewsState {
  lastWakeAt: number;
}

/**
 * Hacker News platform tool MCP — leaf tool surface (P2-E).
 *
 * Sibling of X / Reddit / LinkedIn MCPs but with a critical difference:
 * HN is READ-ONLY. There is no `hn_post` tool — HN's API only permits
 * posting via real-user authentication, and bot-style posting is
 * explicitly against HN's guidelines. Founders who want HN presence
 * must post manually.
 *
 * Tools:
 *   - hn_search — search HN stories + comments via Algolia (anonymous).
 *
 * No OAuth: Algolia's `/search` endpoint is anonymous (shared 10k
 * req/h bucket per IP). There is no `channels` row for `hackernews`
 * because there's no per-user identity to store.
 *
 * `posted_externals` is provisioned for shape consistency with the
 * other platform MCPs but is never written.
 *
 * Migration tag: v8 (P2-E lands all three platforms together).
 */
export class HackerNewsMcpAgent extends McpAgent<
  Env,
  HackerNewsState,
  McpProps & { role?: "lead" | "member" }
> {
  server = new McpServer({
    name: "shipflare-hackernews-mcp",
    version: "1.0.0",
  });
  initialState: HackerNewsState = { lastWakeAt: 0 };

  get sqlStorage(): SqlStorage {
    return this.ctx.storage.sql;
  }
  get bindings(): Env {
    return this.env;
  }

  async onStart(props?: McpProps): Promise<void> {
    applyHackerNewsSchema(this.ctx.storage.sql);
    this.setState({ ...this.state, lastWakeAt: Date.now() });
    await super.onStart(props);
  }

  async init(): Promise<void> {
    registerHackerNewsSearchTool(this);
  }
}
