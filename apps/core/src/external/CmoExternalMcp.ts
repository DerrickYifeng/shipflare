// Phase 7 external MCP surface — per-user, chat-only, OAuth-scoped DO.
//
// Phase 7.0a (this commit) lands the stub so the wrangler.jsonc
// CMO_EXTERNAL_MCP binding + v13 migration tag have a resolvable class
// and the `Env` type compiles.
//
// Phase 7.2 replaces the empty `init()` with the real chat-only tool
// surface (sendChatMessage, listConversations, getConversation, etc.)
// pulled from CMO via per-team RPC.
//
// Phase 7.3 wires `withOAuthProvider` onto the route handler so external
// MCP clients (Claude Desktop, Cursor, founder's own LLM stack) reach
// this DO through the standard OAuth 2.1 flow at mcp.shipflare.com/cmo.
//
// SQLite-backed (see wrangler migration tag v13). Per-tenant — DO id is
// derived from `userId` so each user gets an isolated state namespace.

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "../index";

/**
 * OAuth-provider-supplied identity for the calling client. Set by
 * `@cloudflare/workers-oauth-provider` after the OAuth handshake and
 * threaded through to the McpAgent instance via `props`.
 *
 * Indexed by an arbitrary string key so the type satisfies the McpAgent
 * Props generic (`Record<string, unknown>`); concrete known fields are
 * declared explicitly for in-class consumers.
 */
type CmoExternalProps = {
	userId: string;
	[k: string]: unknown;
};

/**
 * Stub. Phase 7.2 replaces `init()` with the real chat-only tool surface.
 *
 * The `server` field is required by `McpAgent` even on a stub — without it
 * `addMcpServer` / serve helpers in the framework would NPE at registration.
 * The placeholder version string makes it obvious in any errant tool listing
 * that the real surface has not landed yet.
 */
export class CmoExternalMcp extends McpAgent<Env, unknown, CmoExternalProps> {
	server = new McpServer({
		name: "shipflare-cmo",
		version: "0.0.0-stub",
	});

	async init(): Promise<void> {
		// Phase 7.2 registers the chat-only tool set here.
	}
}
