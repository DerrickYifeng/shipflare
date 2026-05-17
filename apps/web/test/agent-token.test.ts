/**
 * Tests for /api/agent-token.
 *
 * The route imports `getCloudflareContext` (a Cloudflare runtime binding)
 * and `getAuth` (a Better Auth helper). Both require an execution context
 * that vitest cannot provide. Following the precedent set by the
 * mcp-token.test.ts tests (which exercise the JWT helper directly and
 * defer full route coverage to Playwright smoke tests), we test the JWT
 * helper round-trip and token claims rather than mounting the route.
 *
 * End-to-end coverage of the route — 401 on missing session, 400 on bad
 * agent param, 200 + JWT on valid request — will be exercised by the
 * Playwright smoke test added in Task 8.6.
 */

import { describe, expect, it } from "vitest";
import { signJwt, verifyJwt, type JwtPayload } from "../src/lib/jwt";

interface AgentTokenClaim extends JwtPayload {
  userId: string;
  agent: string;
  name: string;
}

describe("/api/agent-token — JWT helper", () => {
  const secret = "test-secret-32-bytes-aaaaaaaaaaaaaaaa";

  it("signs a token with userId, agent, and name claims", async () => {
    const token = await signJwt(
      { userId: "u1", agent: "cmo", name: "u1" },
      secret,
      60,
    );
    const payload = (await verifyJwt(token, secret)) as AgentTokenClaim;
    expect(payload.userId).toBe("u1");
    expect(payload.agent).toBe("cmo");
    expect(payload.name).toBe("u1");
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("does not include a scope claim (differs from cmo-ws-token)", async () => {
    const token = await signJwt(
      { userId: "u2", agent: "hog", name: "custom-name" },
      secret,
      60,
    );
    const payload = (await verifyJwt(token, secret)) as AgentTokenClaim & {
      scope?: string;
    };
    expect(payload.scope).toBeUndefined();
    expect(payload.name).toBe("custom-name");
  });

  it("allows caller-supplied name (DO instance override)", async () => {
    const token = await signJwt(
      { userId: "u3", agent: "smm", name: "override-name" },
      secret,
      60,
    );
    const payload = (await verifyJwt(token, secret)) as AgentTokenClaim;
    expect(payload.name).toBe("override-name");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signJwt(
      { userId: "u1", agent: "cmo", name: "u1" },
      secret,
      60,
    );
    await expect(verifyJwt(token, "different-secret")).rejects.toThrow(
      /invalid signature/,
    );
  });

  it("rejects an expired token", async () => {
    const token = await signJwt(
      { userId: "u1", agent: "cmo", name: "u1" },
      secret,
      -1,
    );
    await expect(verifyJwt(token, secret)).rejects.toThrow(/expired/);
  });
});
