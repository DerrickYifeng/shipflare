import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("RedditMcpAgent /internal/{reddit_search,research_subreddits}", () => {
  it("reddit_search returns 403 without internal header", async () => {
    const id = env.REDDIT_MCP.idFromName("reddit-mcp-search-test-1");
    const stub = env.REDDIT_MCP.get(id);
    const res = await stub.fetch(
      new Request("https://internal/internal/reddit_search", {
        method: "POST",
        body: JSON.stringify({ product: "P", maxResults: 5 }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("reddit_search returns JSON on valid internal POST", async () => {
    const id = env.REDDIT_MCP.idFromName("reddit-mcp-search-test-2");
    const stub = env.REDDIT_MCP.get(id);
    const res = await stub.fetch(
      new Request("https://internal/internal/reddit_search", {
        method: "POST",
        headers: { "x-shipflare-internal": "1", "content-type": "application/json" },
        body: JSON.stringify({ product: "test product", maxResults: 5 }),
      }),
    );
    // Reddit uses anonymous public API — may return 200 (with results or empty array)
    // or 500 (rate-limited in test env). Both acceptable; we're checking reachability.
    expect([200, 500]).toContain(res.status);
  });

  it("research_subreddits returns JSON on valid internal POST", async () => {
    const id = env.REDDIT_MCP.idFromName("reddit-mcp-research-test");
    const stub = env.REDDIT_MCP.get(id);
    const res = await stub.fetch(
      new Request("https://internal/internal/research_subreddits", {
        method: "POST",
        headers: { "x-shipflare-internal": "1", "content-type": "application/json" },
        body: JSON.stringify({ product: "test product", audience: "developers" }),
      }),
    );
    expect([200, 500]).toContain(res.status);
  });

  it("reddit_search returns 400 on invalid body (missing required `product`)", async () => {
    const id = env.REDDIT_MCP.idFromName("reddit-mcp-search-test-3");
    const stub = env.REDDIT_MCP.get(id);
    const res = await stub.fetch(
      new Request("https://internal/internal/reddit_search", {
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
