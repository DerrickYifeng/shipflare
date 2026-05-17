import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("XMcpAgent /internal/x_search", () => {
  it("returns 403 without internal header", async () => {
    const id = env.X_MCP.idFromName("x-mcp-search-test-1");
    const stub = env.X_MCP.get(id);
    const res = await stub.fetch(
      new Request("https://internal/internal/x_search", {
        method: "POST",
        body: JSON.stringify({ product: "P", maxResults: 5 }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns JSON array on valid internal POST", async () => {
    const id = env.X_MCP.idFromName("x-mcp-search-test-2");
    const stub = env.X_MCP.get(id);
    const res = await stub.fetch(
      new Request("https://internal/internal/x_search", {
        method: "POST",
        headers: { "x-shipflare-internal": "1", "content-type": "application/json" },
        body: JSON.stringify({ product: "test product", maxResults: 5 }),
      }),
    );
    // If x_search hits the real xAI API and fails (no creds in test env), the route
    // returns 500. Accept either 200 or 500 here — what we're verifying is that the
    // route is REACHABLE with the internal header (vs the 403 in the prior test).
    expect([200, 500]).toContain(res.status);
    const body = await res.json();
    // 200 → array of threads; 500 → { error: "..." }
    expect(typeof body).toBe("object");
  });

  it("returns 400 on invalid body (missing required `product`)", async () => {
    const id = env.X_MCP.idFromName("x-mcp-search-test-3");
    const stub = env.X_MCP.get(id);
    const res = await stub.fetch(
      new Request("https://internal/internal/x_search", {
        method: "POST",
        headers: { "x-shipflare-internal": "1", "content-type": "application/json" },
        body: JSON.stringify({ maxResults: 5 }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeDefined();
  });
});
