/**
 * The `/api/mcp-token` route is a thin wrapper around `signJwt` — its only
 * non-trivial behavior is rejecting unauthenticated requests and bundling
 * the token with a `mcpUrl`. We can't mount the route handler in vitest
 * without a Cloudflare context (it imports `getCloudflareContext`), so we
 * exercise the JWT helper directly here. End-to-end coverage of the route
 * happens via the manual smoke test in S7.A's task notes.
 */

import { describe, expect, it } from "vitest";
import { signJwt, verifyJwt, type JwtPayload } from "../src/lib/jwt";

interface UserClaim extends JwtPayload {
  userId: string;
}

describe("MCP token JWT helper", () => {
  const secret = "test-secret-32-bytes-aaaaaaaaaaaaaaaa";

  it("signs and verifies a token round-trip", async () => {
    const token = await signJwt({ userId: "u1" }, secret, 60);
    const payload = (await verifyJwt(token, secret)) as UserClaim;
    expect(payload.userId).toBe("u1");
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(payload.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signJwt({ userId: "u1" }, secret, 60);
    await expect(verifyJwt(token, "different-secret")).rejects.toThrow(
      /invalid signature/,
    );
  });

  it("rejects an expired token", async () => {
    const token = await signJwt({ userId: "u1" }, secret, -1);
    await expect(verifyJwt(token, secret)).rejects.toThrow(/expired/);
  });
});
