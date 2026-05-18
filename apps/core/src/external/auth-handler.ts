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
			const userId = await resolveUserIdFromSessionCookie(request, env);
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
 * Production (Phase 7.5): the user arrives at `/authorize` in a browser
 * tab the MCP client opened — same origin as `apps/web`, so the Better
 * Auth session cookie rides along. We verify by forwarding the cookie
 * to apps/web's `/api/auth/get-session` over a Service Binding (`env.WEB`).
 * apps/web is the canonical owner of Better Auth — it does the HMAC
 * verification (the cookie value is signed with `BETTER_AUTH_SECRET`),
 * looks up the session row in D1, checks expiry, and returns the user
 * payload. Anything other than a body of shape `{ user: { id: string } }`
 * → 401 (fail closed).
 *
 * Path A was chosen over a direct D1 read of the `session` table
 * because:
 *   1. The cookie value is HMAC-signed (`<token>.<sig>` via
 *      `setSignedCookie` in better-auth's cookies/index.mjs:127).
 *      Re-implementing the verification core-side would mean exporting
 *      `BETTER_AUTH_SECRET` to a second Worker and keeping the HMAC
 *      logic in sync with the upstream package. The service binding
 *      delegates that to the library's own implementation.
 *   2. The session table's expiry semantics may evolve (e.g. rolling
 *      sessions); Better Auth handles those, we shouldn't duplicate.
 *
 * Phase 7.3 SECURITY NOTE: the `x-test-user-id` header is honored ONLY
 * when `env.EXTERNAL_AUTH_TEST_SEAM === "1"`. That binding is set in
 * `apps/core/vitest.config.mts` under `miniflare.bindings` and MUST
 * remain absent from `apps/core/wrangler.jsonc`. If it ever leaks into
 * prod, any caller can mint an OAuth code for any victim's userId (PKCE
 * only proves same-client; it doesn't authenticate the user). The gate
 * mirrors the `STRATEGIC_PATH_FIXTURE` pattern in `onboarding-routes.ts`.
 */
async function resolveUserIdFromSessionCookie(
	request: Request,
	env: Env,
): Promise<string | null> {
	// Test seam — exercised by `apps/core/test/external/auth-handler.test.ts`.
	// Gated on `EXTERNAL_AUTH_TEST_SEAM === "1"` (set ONLY in
	// `apps/core/vitest.config.mts` under `miniflare.bindings`). Production
	// MUST NOT set this binding in `wrangler.jsonc`; if it does, an
	// attacker can POST /authorize with `x-test-user-id: <victim>` and
	// walk away with a valid OAuth code for that user.
	if (env.EXTERNAL_AUTH_TEST_SEAM === "1") {
		const headerUid = request.headers.get("x-test-user-id");
		if (headerUid) return headerUid;
	}

	// Production path — Better Auth session verification via service binding.
	const cookie = request.headers.get("cookie");
	if (!cookie) return null;

	// `env.WEB` is bound to `shipflare-web` (see apps/core/wrangler.jsonc).
	// In vitest the binding is overridden per-test with a Fetcher stub; in
	// `wrangler dev` without `apps/web` running it's undefined — fail closed.
	const web = env.WEB;
	if (!web) {
		console.warn(
			"[auth-handler] WEB service binding unavailable; rejecting /authorize",
		);
		return null;
	}

	try {
		const res = await web.fetch(
			new Request("https://internal/api/auth/get-session", {
				method: "GET",
				headers: { cookie },
			}),
		);
		if (!res.ok) return null;
		// Better Auth returns `null` (literal) when there's no session.
		const body = (await res.json()) as
			| { user?: { id?: unknown } }
			| null;
		if (!body || typeof body !== "object") return null;
		const uid = body.user?.id;
		return typeof uid === "string" && uid.length > 0 ? uid : null;
	} catch (err) {
		// Fail closed — never grant an auth code on a transient WEB error.
		console.warn("[auth-handler] session lookup failed:", err);
		return null;
	}
}
