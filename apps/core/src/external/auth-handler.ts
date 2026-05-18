/**
 * `ExternalAuthHandler` — the `defaultHandler` mounted on the Phase 7
 * `OAuthProvider`. Everything that isn't an `apiHandlers` path
 * (`/cmo/mcp` today) falls through to this fetch handler:
 *
 *   - `/authorize`            — consent UI (GET) + grant completion (POST)
 *   - anything else under the OAuth-provider mount → 404
 *
 * OAuthProvider attaches `env.OAUTH_PROVIDER` lazily right before invoking
 * this handler (see `@cloudflare/workers-oauth-provider/dist/oauth-provider.js`
 * line ~187: `if (!env.OAUTH_PROVIDER) env.OAUTH_PROVIDER = ...`). We can
 * therefore call `env.OAUTH_PROVIDER.parseAuthRequest(...)` /
 * `.lookupClient(...)` / `.completeAuthorization(...)` from inside `fetch`.
 *
 * D7 from the design spec locks v1 to a BARE-BONES consent screen — single
 * "Authorize" button, no scope picker, no avatar. Polish happens after the
 * external surface ships.
 */

import type { Env } from "../index";
import type { AuthRequest, ClientInfo, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/**
 * The OAuth-provider helper lives on `env.OAUTH_PROVIDER` once the provider
 * has dispatched into this default handler. The package's own d.ts declares
 * the helper interface (`OAuthHelpers`); we narrow `Env` locally so the
 * call sites are type-safe without modifying the global Env declaration.
 */
type EnvWithOAuth = Env & { OAUTH_PROVIDER: OAuthHelpers };

export const ExternalAuthHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname !== "/authorize") {
			return new Response("not found", { status: 404 });
		}

		const oauthEnv = env as EnvWithOAuth;

		// Parse the inbound OAuth `/authorize` query (response_type, client_id,
		// redirect_uri, PKCE challenge, state, scope, resource, ...). Throws
		// `OAuthError` on malformed input; let it propagate so the provider
		// returns a spec-compliant error response.
		const oauthReqInfo: AuthRequest = await oauthEnv.OAUTH_PROVIDER.parseAuthRequest(request);
		const clientInfo: ClientInfo | null = await oauthEnv.OAUTH_PROVIDER.lookupClient(
			oauthReqInfo.clientId,
		);
		if (!clientInfo) {
			return new Response("unknown client", { status: 400 });
		}

		// POST = user clicked "Authorize". Resolve their ShipFlare identity,
		// then ask the provider to mint the auth code + redirect.
		if (request.method === "POST") {
			const userId = await resolveUserIdFromSessionCookie(request);
			if (!userId) {
				return new Response("not signed in to ShipFlare", { status: 401 });
			}

			const { redirectTo } = await oauthEnv.OAUTH_PROVIDER.completeAuthorization({
				request: oauthReqInfo,
				userId,
				scope: ["cmo:chat"],
				metadata: {
					clientName: clientInfo.clientName ?? "Unknown MCP client",
				},
				// Props ride along on every authenticated request to apiHandlers
				// — i.e. `CmoExternalMcp` will see `{ userId, scopes }` on
				// `this.props` (verified end-to-end via the provider's
				// encrypted token).
				props: { userId, scopes: ["cmo:chat"] },
			});
			return Response.redirect(redirectTo, 302);
		}

		// GET — render the consent screen.
		const clientName = clientInfo.clientName ?? "an MCP client";
		const html = renderConsent(clientName);
		return new Response(html, {
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	},
} satisfies ExportedHandler<Env>;

function renderConsent(clientName: string): string {
	const safeName = escapeHtml(clientName);
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<title>Authorize ${safeName} — ShipFlare</title>
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<style>
		body { font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 80px auto; padding: 24px; color: #1a1a1a; }
		h1 { font-size: 1.5rem; margin: 0 0 16px; }
		p { line-height: 1.5; color: #444; }
		.actions { margin-top: 32px; display: flex; gap: 12px; align-items: center; }
		button { background: #1a1a1a; color: white; border: none; padding: 10px 18px; border-radius: 6px; cursor: pointer; font-size: 1rem; }
		button:hover { background: #333; }
		a { color: #666; text-decoration: none; }
		a:hover { text-decoration: underline; }
	</style>
</head>
<body>
	<h1>Authorize ${safeName}?</h1>
	<p>This MCP client is requesting permission to chat with your ShipFlare CMO.</p>
	<p>The CMO can review your pending drafts, plan posts, and act on your behalf.</p>
	<form method="POST">
		<div class="actions">
			<button type="submit">Authorize</button>
			<a href="javascript:window.close()">Cancel</a>
		</div>
	</form>
</body>
</html>`;
}

function escapeHtml(s: string): string {
	const map: Record<string, string> = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	};
	return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

/**
 * Resolve the ShipFlare user id from the inbound request.
 *
 * Production: the user arrives at `/authorize` in a browser tab the MCP
 * client opened — same origin as `apps/web`, so the Better Auth session
 * cookie rides along. The right way to verify is to delegate to
 * `apps/web`'s `/api/auth/session` (Service Binding) or read the shared
 * D1 session table directly.
 *
 * Phase 7.5 wires the real session check. For 7.3 the handler accepts a
 * test header so the auth-handler tests + manual Inspector smoke can
 * exercise the consent → grant → token flow end-to-end without standing
 * up a full apps/web session.
 *
 * TODO(phase-7.5): replace this with a real Better Auth verification.
 * Two options on the table:
 *   (a) Service-binding fetch to apps/web's `/api/auth/session` — clean
 *       separation, follows the existing pattern used by
 *       `apps/web/app/api/agent-token/route.ts`.
 *   (b) Read the Better Auth session row directly from D1 — tighter
 *       coupling but no extra hop.
 */
async function resolveUserIdFromSessionCookie(request: Request): Promise<string | null> {
	// Test seam — exercised by `apps/core/test/external/auth-handler.test.ts`.
	const headerUid = request.headers.get("x-test-user-id");
	if (headerUid) return headerUid;

	// TODO(phase-7.5): verify Better Auth session cookie. See doc comment above.
	return null;
}
