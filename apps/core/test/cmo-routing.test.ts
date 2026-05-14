import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signJwt } from "../src/lib/jwt";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Tests for the Worker entry routing wired in S2.6.
 *
 * Coverage:
 *  - /agents/<role>/<userId>/internal/<path> — header-gated; 200 happy
 *    path forwards to the CMO DO's fetch handler.
 *  - /agents/<role>/<userId>/mcp — JWT-protected. 401 / 403 / 404 negative
 *    paths are exercised here; the JWT happy-path round-trips through the
 *    CMO McpAgent transport which needs a full Streamable-HTTP handshake
 *    that's out of scope for unit tests (verified manually via wrangler
 *    dev + curl per the task brief).
 *
 * Notes:
 *  - `MCP_JWT_SECRET` is supplied by `apps/core/.dev.vars` (read by
 *    vitest-pool-workers + `wrangler dev`). We sign with the same secret the
 *    Worker verifies against, which is exactly what the production browser →
 *    core flow does. Production overrides via `wrangler secret put`.
 */

const INTERNAL_HEADERS = {
  "x-shipflare-internal": "1",
  "content-type": "application/json",
};

/**
 * Bootstrap the CMO DO's SQL schema via the same stub the Worker will reach
 * (DO identity is keyed on `idFromName(userId)`, which is deterministic).
 *
 * Why: the test goes Worker → DO via `SELF.fetch`, so the DO's `onStart`
 * never runs (parent McpAgent's transport init is what wakes it, and the
 * non-`sse:`/`streamable-http:`/`rpc:` DO name short-circuits that). The
 * existing CMO test suite uses the same workaround for direct stub tests —
 * see `cmo-internal.test.ts`.
 */
async function bootstrapCmoFor(userId: string): Promise<void> {
  const stub = env.CMO.get(env.CMO.idFromName(userId));
  await runInDurableObject(stub, async (_instance: CMO, state) => {
    applyCmoSchema(state.storage.sql);
  });
}

describe("Worker /agents/<role>/<userId>/internal/* routing", () => {
  it("forwards /internal/init to the CMO DO (200 + 'initialized')", async () => {
    await bootstrapCmoFor("route-init-user-1");
    const res = await SELF.fetch(
      "https://example.com/agents/cmo/route-init-user-1/internal/init",
      {
        method: "POST",
        headers: INTERNAL_HEADERS,
        body: JSON.stringify({ email: "a@b.c", githubLogin: null }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("initialized");
  });

  it("returns 403 without x-shipflare-internal header", async () => {
    const res = await SELF.fetch(
      "https://example.com/agents/cmo/route-init-user-2/internal/init",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.c", githubLogin: null }),
      },
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 for unknown role at /agents/<role>/<userId>/internal/", async () => {
    const res = await SELF.fetch(
      "https://example.com/agents/ghost-role/u1/internal/init",
      {
        method: "POST",
        headers: INTERNAL_HEADERS,
        body: "{}",
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 503 when role's DO namespace binding is not deployed yet", async () => {
    // social-media-manager has a `SOCIAL_MEDIA_MGR` binding in ROLE_REGISTRY
    // but the wrangler.jsonc binding for it isn't enabled until S4. The
    // Worker's internal route should surface a 503 (not 500) for this case.
    // (S3 enabled HEAD_OF_GROWTH, so this test moved one role down the
    // staging order; the next still-commented binding is SMM.)
    const res = await SELF.fetch(
      "https://example.com/agents/social-media-manager/u1/internal/init",
      {
        method: "POST",
        headers: INTERNAL_HEADERS,
        body: "{}",
      },
    );
    expect(res.status).toBe(503);
  });
});

describe("Worker /agents/<role>/<userId>/mcp routing", () => {
  const SECRET = env.MCP_JWT_SECRET;

  it("returns 401 without an Authorization header", async () => {
    const res = await SELF.fetch(
      "https://example.com/agents/cmo/mcp-user-1/mcp",
      { method: "POST" },
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for a malformed bearer token", async () => {
    const res = await SELF.fetch(
      "https://example.com/agents/cmo/mcp-user-2/mcp",
      {
        method: "POST",
        headers: { authorization: "Bearer not.a.real.jwt" },
      },
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired token", async () => {
    const token = await signJwt({ userId: "mcp-user-3" }, SECRET, -10);
    const res = await SELF.fetch(
      "https://example.com/agents/cmo/mcp-user-3/mcp",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when JWT userId doesn't match URL userId", async () => {
    const token = await signJwt({ userId: "userA" }, SECRET, 60);
    const res = await SELF.fetch(
      "https://example.com/agents/cmo/userB/mcp",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 for non-cmo roles (Phase 1 only exposes cmo at /agents)", async () => {
    const token = await signJwt({ userId: "userA" }, SECRET, 60);
    const res = await SELF.fetch(
      "https://example.com/agents/head-of-growth/userA/mcp",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(404);
  });
});
