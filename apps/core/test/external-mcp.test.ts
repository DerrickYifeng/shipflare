/**
 * Tests for the Phase 2 external MCP route (`/external/agents/<role>/<userId>/mcp`).
 *
 * Coverage:
 *  - Auth-failure modes: missing bearer, malformed jwt, expired, wrong
 *    secret, userId mismatch, role mismatch, missing/empty scope
 *  - Happy paths: matching token, `role === "*"` wildcard, all three
 *    employee classes (cmo / head-of-growth / social-media-manager)
 *  - Route precedence: `/external/agents/...` is matched BEFORE the
 *    Phase 1 `/agents/...` route
 *
 * The McpAgent transport handshake itself (Streamable HTTP framing,
 * session-id stickiness, etc.) is out of scope for unit tests — those
 * paths are exercised manually via `wrangler dev` + curl per the task
 * brief. Here we only assert the WORKER ENTRY behaves correctly: 401 on
 * bad auth, dispatched-to-McpAgent on good auth.
 *
 * `EXTERNAL_MCP_SECRET` and `MCP_JWT_SECRET` are supplied by
 * `apps/core/.dev.vars`. We sign with the same secret the Worker
 * verifies against, mirroring the production flow where apps/web's
 * /api/external-mcp/issue signs with EXTERNAL_MCP_SECRET and apps/core
 * verifies on the request side.
 */

import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signJwt } from "../src/lib/jwt";

const EXTERNAL_SECRET = env.EXTERNAL_MCP_SECRET;
const MCP_SECRET = env.MCP_JWT_SECRET;

describe("Worker /external/agents/<role>/<userId>/mcp routing", () => {
  it("returns 401 without an Authorization header", async () => {
    const res = await SELF.fetch(
      "https://example.com/external/agents/cmo/ext-user-1/mcp",
      { method: "POST" },
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for a malformed bearer token", async () => {
    const res = await SELF.fetch(
      "https://example.com/external/agents/cmo/ext-user-1/mcp",
      {
        method: "POST",
        headers: { authorization: "Bearer not.a.real.jwt" },
      },
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired token", async () => {
    const token = await signJwt(
      { userId: "ext-user-2", role: "cmo", scope: ["read"] },
      EXTERNAL_SECRET,
      -10,
    );
    const res = await SELF.fetch(
      "https://example.com/external/agents/cmo/ext-user-2/mcp",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when the token is signed with the wrong secret", async () => {
    // Sign with MCP_JWT_SECRET (the browser-session secret) — should NOT be
    // accepted by the external route. This is the whole point of the
    // separate signing secret.
    const token = await signJwt(
      { userId: "ext-user-3", role: "cmo", scope: ["read"] },
      MCP_SECRET,
      60,
    );
    const res = await SELF.fetch(
      "https://example.com/external/agents/cmo/ext-user-3/mcp",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token userId doesn't match URL userId", async () => {
    const token = await signJwt(
      { userId: "user-a", role: "cmo", scope: ["read"] },
      EXTERNAL_SECRET,
      60,
    );
    const res = await SELF.fetch(
      "https://example.com/external/agents/cmo/user-b/mcp",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token role doesn't match URL role", async () => {
    const token = await signJwt(
      { userId: "user-a", role: "head-of-growth", scope: ["read"] },
      EXTERNAL_SECRET,
      60,
    );
    const res = await SELF.fetch(
      "https://example.com/external/agents/cmo/user-a/mcp",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token scope array is empty", async () => {
    const token = await signJwt(
      { userId: "user-a", role: "cmo", scope: [] },
      EXTERNAL_SECRET,
      60,
    );
    const res = await SELF.fetch(
      "https://example.com/external/agents/cmo/user-a/mcp",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token scope is missing", async () => {
    const token = await signJwt(
      { userId: "user-a", role: "cmo" },
      EXTERNAL_SECRET,
      60,
    );
    const res = await SELF.fetch(
      "https://example.com/external/agents/cmo/user-a/mcp",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(401);
  });

  it("accepts a valid token for cmo and dispatches past auth (not 401)", async () => {
    const token = await signJwt(
      { userId: "ext-cmo-user", role: "cmo", scope: ["read"] },
      EXTERNAL_SECRET,
      60,
    );
    const res = await SELF.fetch(
      "https://example.com/external/agents/cmo/ext-cmo-user/mcp",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    // Past auth: McpAgent.serve may itself return a non-2xx (it expects a
    // valid JSON-RPC handshake body which a bare POST doesn't supply), but
    // it must NOT be 401 — that would mean we never got past the auth gate.
    expect(res.status).not.toBe(401);
  });

  it("accepts a valid token for head-of-growth", async () => {
    const token = await signJwt(
      { userId: "ext-hog-user", role: "head-of-growth", scope: ["read"] },
      EXTERNAL_SECRET,
      60,
    );
    const res = await SELF.fetch(
      "https://example.com/external/agents/head-of-growth/ext-hog-user/mcp",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).not.toBe(401);
  });

  it("accepts a valid token for social-media-manager", async () => {
    const token = await signJwt(
      {
        userId: "ext-smm-user",
        role: "social-media-manager",
        scope: ["read"],
      },
      EXTERNAL_SECRET,
      60,
    );
    const res = await SELF.fetch(
      "https://example.com/external/agents/social-media-manager/ext-smm-user/mcp",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).not.toBe(401);
  });

  it("accepts wildcard role=\"*\" for any URL role", async () => {
    const token = await signJwt(
      { userId: "ext-star-user", role: "*", scope: ["admin"] },
      EXTERNAL_SECRET,
      60,
    );
    const res = await SELF.fetch(
      "https://example.com/external/agents/cmo/ext-star-user/mcp",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).not.toBe(401);
  });

  it("returns 404 for unknown role even with a valid wildcard token", async () => {
    const token = await signJwt(
      { userId: "ext-ghost-user", role: "*", scope: ["read"] },
      EXTERNAL_SECRET,
      60,
    );
    const res = await SELF.fetch(
      "https://example.com/external/agents/ghost-role/ext-ghost-user/mcp",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(404);
  });

  it("/external/agents/... does NOT collide with /agents/... (Phase 1)", async () => {
    // Sanity-check that the Phase 1 route still 401s without an MCP_JWT
    // header — i.e. /external prefix matching didn't break the /agents
    // matcher. We send NO auth header; both routes 401 without auth, but
    // for *different* reasons. The key assertion is that both routes
    // STILL respond (not 404).
    const externalRes = await SELF.fetch(
      "https://example.com/external/agents/cmo/no-auth-user/mcp",
      { method: "POST" },
    );
    const internalRes = await SELF.fetch(
      "https://example.com/agents/cmo/no-auth-user/mcp",
      { method: "POST" },
    );
    expect(externalRes.status).toBe(401);
    expect(internalRes.status).toBe(401);
  });
});
