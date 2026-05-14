import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpProps } from "@shipflare/shared";
import type { Env } from "../../../index";
import { applyDiscordSchema } from "./schema";
import { registerDiscordPostTool } from "./tools/discord-post";
import { registerDiscordSearchTool } from "./tools/discord-search";

interface DiscordState {
  lastWakeAt: number;
}

/**
 * Discord platform tool MCP — leaf tool surface (P2-E).
 *
 * Sibling of X / Reddit / LinkedIn MCPs. Discord differs from the other
 * platforms in auth shape: there is no end-user OAuth flow for a bot.
 * The founder generates a Bot Token in the Discord Developer Portal,
 * pastes it (along with a default channel id) into the form at
 * `/api/channels/discord/connect`, and the web Worker AES-GCM-encrypts
 * + stores it in `channels.oauthTokenEncrypted` so this DO can read it
 * back via `getChannel(env, userId, "discord")` (the only sanctioned
 * decrypt path; CLAUDE.md Security TODO §1).
 *
 * Tools:
 *   - discord_post   — send a message to a channel via the bot.
 *   - discord_search — STUB (Discord has no broad-search API for bots).
 *
 * Phase 2 P2-E.2 follow-up: replace the lo-fi form-POST connect flow
 * with the real Discord OAuth bot install (Authorize → Add to Server →
 * Permissions grant), and wire per-channel polling for inbound
 * monitoring.
 *
 * Migration tag: v8 (P2-E lands all three platforms together).
 */
export class DiscordMcpAgent extends McpAgent<
  Env,
  DiscordState,
  McpProps & { role?: "lead" | "member" }
> {
  server = new McpServer({
    name: "shipflare-discord-mcp",
    version: "1.0.0",
  });
  initialState: DiscordState = { lastWakeAt: 0 };

  get sqlStorage(): SqlStorage {
    return this.ctx.storage.sql;
  }
  get bindings(): Env {
    return this.env;
  }

  async onStart(props?: McpProps): Promise<void> {
    applyDiscordSchema(this.ctx.storage.sql);
    this.setState({ ...this.state, lastWakeAt: Date.now() });
    await super.onStart(props);
  }

  async init(): Promise<void> {
    registerDiscordPostTool(this);
    registerDiscordSearchTool(this);
  }
}
