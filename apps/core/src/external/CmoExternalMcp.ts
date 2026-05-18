// Phase 7 external MCP surface — per-user, chat-only, OAuth-scoped DO.
//
// Phase 7.0a landed the stub so the wrangler.jsonc CMO_EXTERNAL_MCP
// binding + v13 migration tag had a resolvable class and `Env` compiled.
//
// Phase 7.2 (this commit) replaces the empty `init()` with the real
// chat-only tool surface. Per [[feedback_external_mcp_chat_surface]] /
// design spec §3, the external MCP intentionally exposes ONE tool —
// `chat` — and lets the CMO LLM dispatch internally. Exposing a
// per-tool surface here would double maintenance and confuse the LLM
// about which path to use.
//
// Phase 7.3 wires `withOAuthProvider` onto the route handler so external
// MCP clients (Claude Desktop, Cursor, founder's own LLM stack) reach
// this DO through the standard OAuth 2.1 flow at mcp.shipflare.com/cmo.
//
// SQLite-backed (see wrangler migration tag v13). Per-tenant — DO id is
// derived from `userId` so each user gets an isolated state namespace.

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
export type CmoExternalProps = {
	userId: string;
	scopes: string[];
	[k: string]: unknown;
};

/**
 * Per-user external MCP DO. Each ShipFlare user gets one instance, keyed
 * off `props.userId` via Agents SDK session plumbing. ONE tool: `chat`.
 *
 * The CMO LLM already knows how to invoke its 14 internal tools + consult
 * peers based on natural-language intent. Exposing a separate per-tool
 * surface here would double maintenance and confuse the LLM about which
 * path to use. See [[feedback_external_mcp_chat_surface]].
 *
 * Props are populated by OAuthProvider's auth handler (Phase 7.3):
 *   { userId, scopes }
 * — verified Bearer → decrypted → attached to this.props on every request.
 *
 * In vitest the OAuth provider isn't running, so tests inject a
 * `_testProps` field directly on the instance (mirrors the `_alarmDryRun`
 * pattern from 5.1c.13).
 */
export class CmoExternalMcp extends McpAgent<Env, unknown, CmoExternalProps> {
	server = new McpServer({
		name: "shipflare-cmo",
		version: "1.0.0",
	});

	async init(): Promise<void> {
		// Capture `this` so the tool handler closure can reach instance
		// state (env, props, test seam) at invocation time. The McpServer
		// `registerTool` callback isn't bound to the agent.
		const self = this;
		this.server.registerTool(
			"chat",
			{
				description:
					"Talk to your ShipFlare CMO. Ask anything — review pending drafts, " +
					"plan today's posts, get strategic guidance. The CMO has full access " +
					"to your team (SMM, HoG) and can act on your behalf.",
				inputSchema: { message: z.string().min(1).max(4000) },
			},
			async ({ message }: { message: string }) => {
				// Test seam: vitest sets `_testProps` directly on the instance
				// (OAuth provider isn't running in unit tests). Production path
				// uses OAuth-populated `this.props`. Same pattern as
				// `_alarmDryRun` (5.1c.13) and `_invokeAsToolDryRun` (7.1).
				const propsHack = (self as unknown as {
					_testProps?: CmoExternalProps;
				})._testProps;
				const userId = propsHack?.userId ?? self.props?.userId;
				if (!userId) {
					throw new Error(
						"CmoExternalMcp.chat: missing userId in props",
					);
				}

				// DO RPC to the real CMO. `invokeAsTool` is public on CMO
				// (Phase 7.1) so the DO stub auto-exposes it via Cloudflare's
				// Worker-to-DO RPC plumbing. Internal MCP DOs (CMO, HoG, SMM)
				// continue to address CMO by `streamable-http:${userId}` —
				// see CLAUDE.md "CMO SQLite is the per-team source of truth"
				// (writes go through CMO's exposed tools, not direct SQL).
				const cmoStub = self.env.CMO.getByName(
					`streamable-http:${userId}`,
				);
				const reply = await (
					cmoStub as unknown as {
						invokeAsTool: (
							tool: "chat",
							args: { message: string },
						) => Promise<string>;
					}
				).invokeAsTool("chat", { message });

				return {
					content: [
						{ type: "text" as const, text: String(reply ?? "") },
					],
				};
			},
		);
	}
}
