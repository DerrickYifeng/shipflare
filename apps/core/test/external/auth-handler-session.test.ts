/**
 * Phase 7.5 — real Better Auth session-cookie verification on `/authorize`.
 *
 * The Phase 7.3 sibling test (`auth-handler.test.ts`) covers the
 * `x-test-user-id` seam gated on `EXTERNAL_AUTH_TEST_SEAM`. This file
 * covers the PRODUCTION code path with the seam OFF: the request must
 * carry a real Better Auth session cookie, and core verifies it by
 * fetching apps/web's `/api/auth/get-session` via the `WEB` Service
 * Binding (since apps/web is the canonical owner of Better Auth state
 * and the cookie value is HMAC-signed with `BETTER_AUTH_SECRET`).
 *
 * In vitest-pool-workers the real apps/web Worker isn't running, so
 * we override `env.WEB` with a Fetcher stub before each test:
 *   - happy path  — stub returns 200 with `{ user: { id: "<uid>" } }`
 *   - no cookie   — handler returns 401 without calling WEB
 *   - unsigned-in — stub returns 200 with `null` (Better Auth's shape
 *     when there's no session); handler returns 401
 *   - expired     — same as unsigned-in (Better Auth filters out
 *     expired sessions server-side)
 *   - WEB error   — stub returns 500; handler returns 401 (fail closed)
 *
 * If this gate ever flips open (the production path returns a userId
 * without consulting WEB), an attacker can mint an OAuth code for any
 * victim. Do NOT relax these tests without re-reading
 * `apps/core/src/external/auth-handler.ts:resolveUserIdFromSessionCookie`.
 */

import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGIN = "https://example.com";
const CLIENT_REDIRECT = "http://localhost:9999/callback";

interface DcrResponse {
  client_id: string;
  redirect_uris: string[];
}

async function registerPublicClient(): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [CLIENT_REDIRECT],
      client_name: "vitest session-verify client",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as DcrResponse;
  return body.client_id;
}

function buildAuthorizeUrl(clientId: string): string {
  const u = new URL(`${ORIGIN}/authorize`);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", CLIENT_REDIRECT);
  u.searchParams.set("scope", "cmo:chat");
  u.searchParams.set("state", "test-state");
  u.searchParams.set(
    "code_challenge",
    "abc123abc123abc123abc123abc123abc123abc123ab",
  );
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/**
 * Minimal Fetcher stub used in place of `env.WEB`. `lastRequest` lets
 * tests assert the handler forwarded the inbound `cookie` header and
 * hit the right endpoint.
 */
interface WebStub {
  fetcher: Fetcher;
  lastRequest: Request | null;
}

function makeWebStub(handler: (req: Request) => Response | Promise<Response>): WebStub {
  const stub: WebStub = { fetcher: {} as Fetcher, lastRequest: null };
  stub.fetcher = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      stub.lastRequest = req;
      return handler(req);
    },
  } as unknown as Fetcher;
  return stub;
}

interface MutableEnv {
  EXTERNAL_AUTH_TEST_SEAM?: string;
  WEB?: Fetcher;
}

describe("ExternalAuthHandler — production session verification (7.5)", () => {
  const e = env as unknown as MutableEnv;
  const ORIGINAL_SEAM = e.EXTERNAL_AUTH_TEST_SEAM;
  const ORIGINAL_WEB = e.WEB;

  beforeEach(() => {
    // Production posture: the test seam MUST be off so we exercise the
    // real Better-Auth verification path. The previous Phase-7.3 test
    // already proves the seam-off + missing-cookie path returns 401,
    // but we re-pin it here to make this test file self-contained.
    e.EXTERNAL_AUTH_TEST_SEAM = undefined;
  });

  afterEach(() => {
    e.EXTERNAL_AUTH_TEST_SEAM = ORIGINAL_SEAM;
    e.WEB = ORIGINAL_WEB;
  });

  it("happy path: valid session cookie → 302 with auth code", async () => {
    const stub = makeWebStub(() =>
      new Response(JSON.stringify({ user: { id: "user-real-session-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    e.WEB = stub.fetcher;

    const clientId = await registerPublicClient();
    const res = await SELF.fetch(buildAuthorizeUrl(clientId), {
      method: "POST",
      headers: { cookie: "better-auth.session_token=signed-token-here" },
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(CLIENT_REDIRECT)).toBe(true);
    const redirectUrl = new URL(location);
    expect(redirectUrl.searchParams.get("code")).toBeTruthy();
    expect(redirectUrl.searchParams.get("state")).toBe("test-state");

    // Verify the handler forwarded the cookie to apps/web.
    expect(stub.lastRequest).not.toBeNull();
    const fwd = stub.lastRequest!;
    expect(new URL(fwd.url).pathname).toBe("/api/auth/get-session");
    expect(fwd.headers.get("cookie")).toBe(
      "better-auth.session_token=signed-token-here",
    );
  });

  it("no cookie present → 401 without contacting WEB", async () => {
    const stub = makeWebStub(() => {
      throw new Error("WEB must not be called when no cookie is present");
    });
    e.WEB = stub.fetcher;

    const clientId = await registerPublicClient();
    const res = await SELF.fetch(buildAuthorizeUrl(clientId), {
      method: "POST",
      redirect: "manual",
    });

    expect(res.status).toBe(401);
    expect(await res.text()).toContain("not signed in");
    expect(stub.lastRequest).toBeNull();
  });

  it("Better Auth returns null user (no/expired session) → 401", async () => {
    // Better Auth's `/api/auth/get-session` returns 200 with `null` body
    // when there is no session OR when the session is expired (it does
    // the expiry check server-side and returns null either way).
    const stub = makeWebStub(() =>
      new Response("null", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    e.WEB = stub.fetcher;

    const clientId = await registerPublicClient();
    const res = await SELF.fetch(buildAuthorizeUrl(clientId), {
      method: "POST",
      headers: { cookie: "better-auth.session_token=tampered-or-expired" },
      redirect: "manual",
    });

    expect(res.status).toBe(401);
    expect(await res.text()).toContain("not signed in");
  });

  it("Better Auth returns a body without user.id → 401 (fail closed)", async () => {
    const stub = makeWebStub(() =>
      new Response(JSON.stringify({ session: { token: "x" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    e.WEB = stub.fetcher;

    const clientId = await registerPublicClient();
    const res = await SELF.fetch(buildAuthorizeUrl(clientId), {
      method: "POST",
      headers: { cookie: "better-auth.session_token=signed-token" },
      redirect: "manual",
    });

    expect(res.status).toBe(401);
  });

  it("WEB binding error → 401 (fail closed, not 500)", async () => {
    const stub = makeWebStub(() =>
      new Response("internal", { status: 500 }),
    );
    e.WEB = stub.fetcher;

    const clientId = await registerPublicClient();
    const res = await SELF.fetch(buildAuthorizeUrl(clientId), {
      method: "POST",
      headers: { cookie: "better-auth.session_token=signed-token" },
      redirect: "manual",
    });

    expect(res.status).toBe(401);
    expect(await res.text()).toContain("not signed in");
  });

  it("WEB binding throws → 401 (fail closed)", async () => {
    const stub = makeWebStub(() => {
      throw new Error("network blew up");
    });
    e.WEB = stub.fetcher;

    const clientId = await registerPublicClient();
    const res = await SELF.fetch(buildAuthorizeUrl(clientId), {
      method: "POST",
      headers: { cookie: "better-auth.session_token=signed-token" },
      redirect: "manual",
    });

    expect(res.status).toBe(401);
  });
});
