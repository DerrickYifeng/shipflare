/**
 * Integration tests for the Phase 7 OAuthProvider mount. We hit the live
 * Worker via `SELF.fetch` (no in-process probes) so the OAuthProvider
 * configured in `apps/core/src/index.ts` actually runs — the auth-handler
 * is reachable only through the provider's dispatch.
 *
 * What this file locks:
 *   - `/cmo/mcp` is owned by the provider and rejects unauthenticated
 *     traffic with 401.
 *   - `/.well-known/oauth-authorization-server` returns the RFC 8414
 *     server metadata (clients use it to discover token + authorize URLs).
 *   - `/authorize` GET renders an HTML consent screen when the client is
 *     known (dynamic-client-registration creates one inline).
 *   - `/authorize` POST without a resolved ShipFlare user returns 401.
 *   - `/authorize` POST with the `x-test-user-id` seam completes the
 *     grant and 302s back to the client redirect URI with a `code` param.
 *
 * Existing routes (`/healthz`, `/agents/cmo/<uid>/mcp`) MUST still work —
 * they're covered by `apps/core/test/healthz.test.ts` and
 * `apps/core/test/cmo-routing.test.ts`, both of which run as part of the
 * same vitest pass.
 */

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://example.com";
const CLIENT_REDIRECT = "http://localhost:9999/callback";

interface DcrResponse {
  client_id: string;
  redirect_uris: string[];
}

/**
 * Register a public client via the provider's RFC 7591 DCR endpoint.
 * Returns the assigned client_id for use in subsequent /authorize calls.
 */
async function registerPublicClient(): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [CLIENT_REDIRECT],
      client_name: "vitest mcp client",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as DcrResponse;
  expect(body.client_id).toBeTruthy();
  return body.client_id;
}

function buildAuthorizeUrl(clientId: string): string {
  const u = new URL(`${ORIGIN}/authorize`);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", CLIENT_REDIRECT);
  u.searchParams.set("scope", "cmo:chat");
  u.searchParams.set("state", "test-state");
  // S256 PKCE — `disallowPlainPKCE: false` is the provider default for
  // 2.1 compliance, so we MUST send a non-plain challenge.
  u.searchParams.set("code_challenge", "abc123abc123abc123abc123abc123abc123abc123ab");
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

describe("ExternalAuthHandler — OAuth provider mount", () => {
  it("`/cmo/mcp` without a Bearer returns 401", async () => {
    const res = await SELF.fetch(`${ORIGIN}/cmo/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("`/.well-known/oauth-authorization-server` returns RFC 8414 metadata", async () => {
    const res = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.authorization_endpoint ?? "")).toContain("/authorize");
    expect(String(body.token_endpoint ?? "")).toContain("/oauth/token");
    // Scopes the provider advertises — must match `scopesSupported` in
    // the provider config so DCR clients can ask for the right grant.
    expect(body.scopes_supported).toEqual(["cmo:chat"]);
  });

  it("`/authorize` GET renders the bare-bones HTML consent screen", async () => {
    const clientId = await registerPublicClient();
    const res = await SELF.fetch(buildAuthorizeUrl(clientId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("Authorize");
    expect(html).toContain("ShipFlare CMO");
    expect(html).toContain("<form");
    expect(html).toContain('method="POST"');
  });

  it("`/authorize` POST without a session returns 401", async () => {
    const clientId = await registerPublicClient();
    const res = await SELF.fetch(buildAuthorizeUrl(clientId), {
      method: "POST",
      redirect: "manual",
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("not signed in");
  });

  it("`/authorize` POST with x-test-user-id seam completes the grant and 302s", async () => {
    const clientId = await registerPublicClient();
    const res = await SELF.fetch(buildAuthorizeUrl(clientId), {
      method: "POST",
      headers: { "x-test-user-id": "user-vitest-7" },
      redirect: "manual",
    });
    // OAuthProvider mints the auth code + builds the redirect URL via
    // `Response.redirect(redirectTo, 302)`.
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(CLIENT_REDIRECT)).toBe(true);
    const redirectUrl = new URL(location);
    expect(redirectUrl.searchParams.get("code")).toBeTruthy();
    expect(redirectUrl.searchParams.get("state")).toBe("test-state");
  });

  it("paths the provider doesn't own fall through to the main worker", async () => {
    // `/healthz` is outside the OAuth-provider mount, so it MUST still
    // return 200 — proving the provider doesn't swallow non-OAuth routes.
    const res = await SELF.fetch(`${ORIGIN}/healthz`);
    expect(res.status).toBe(200);
  });
});
