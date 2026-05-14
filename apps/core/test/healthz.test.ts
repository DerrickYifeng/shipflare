import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("apps/core healthz + routing stubs", () => {
  it("GET /healthz returns ok:true", async () => {
    const res = await SELF.fetch("https://example.com/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ts: number };
    expect(body.ok).toBe(true);
    expect(typeof body.ts).toBe("number");
  });

  it("GET /unknown returns 404", async () => {
    const res = await SELF.fetch("https://example.com/unknown");
    expect(res.status).toBe(404);
  });

  it("GET /agents/cmo/u1/mcp without auth returns 401", async () => {
    // S2.6 wired the route. Without a Bearer token, MCP path returns 401.
    const res = await SELF.fetch("https://example.com/agents/cmo/u1/mcp");
    expect(res.status).toBe(401);
  });
});
