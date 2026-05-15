import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { XMcpAgent } from "../src/agents/platforms/x/XMcpAgent";
import type { RedditMcpAgent } from "../src/agents/platforms/reddit/RedditMcpAgent";

/**
 * S5.3 — integration smoke for the X_MCP + REDDIT_MCP DO bindings.
 *
 * After S5.3 wires the platform DO bindings + migration tag v4 into
 * wrangler.jsonc, the SMM's `find_threads_via_xai` / `research_reddit_channels`
 * paths reach their platform tool MCPs via RPC over an `addMcpServer` pipe.
 *
 * Full end-to-end RPC verification (SMM connectToPeers → addMcpServer →
 * platform tool execution → response back to SMM) needs both DOs initialized
 * under transport names; that's deferred to S10 (Playwright + real wrangler
 * dev). What this test covers — and what S5.3's contract actually requires —
 * is:
 *
 *   1. The X_MCP and REDDIT_MCP bindings are present on `env` (i.e.
 *      wrangler.jsonc was uncommented + migration tag v4 took effect).
 *   2. Each binding can resolve a DO stub by name without throwing.
 *   3. The DO's SQLite schema bootstrap function applies cleanly against
 *      its own storage (i.e. the migration tag landed the class in a
 *      working SQLite-backed namespace).
 *
 * Borrowing-a-CMO discipline from `x-mcp-schema.test.ts` is no longer
 * necessary here — we can use the real X_MCP / REDDIT_MCP namespaces now
 * that they're bound. Same non-transport-name + manual `applyXSchema` /
 * `applyRedditSchema` pattern as the dedicated schema tests, because
 * `getByName(non-transport-prefix)` still skips the parent McpAgent's
 * `onStart()` transport-init path.
 */

describe("SMM ↔ X_MCP / REDDIT_MCP RPC plumbing (S5.3 integration smoke)", () => {
  it("X_MCP binding exists in env", () => {
    expect(env.X_MCP).toBeDefined();
    expect(typeof env.X_MCP.getByName).toBe("function");
  });

  it("REDDIT_MCP binding exists in env", () => {
    expect(env.REDDIT_MCP).toBeDefined();
    expect(typeof env.REDDIT_MCP.getByName).toBe("function");
  });

  it("X_MCP DO can be instantiated by name + schema bootstraps", async () => {
    const stub = env.X_MCP.getByName("smoke-test-x");
    await runInDurableObject(stub, async (_instance: XMcpAgent, state) => {
      // Non-transport name skips the McpAgent.onStart() path (S2.0 finding),
      // so the DO's auto-bootstrap doesn't run; drive applyXSchema manually
      // to verify the migration's SQLite namespace is functional.
      const { applyXSchema } = await import(
        "../src/agents/platforms/x/schema"
      );
      applyXSchema(state.storage.sql);

      const tables = state.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type='table'
             AND name IN ('rate_limits', 'call_cache', 'posted_externals')
           ORDER BY name`,
        )
        .toArray()
        .map((r) => r.name);

      expect(tables).toEqual([
        "call_cache",
        "posted_externals",
        "rate_limits",
      ]);
    });
  });

  it("REDDIT_MCP DO can be instantiated by name + schema bootstraps", async () => {
    const stub = env.REDDIT_MCP.getByName("smoke-test-r");
    await runInDurableObject(stub, async (_instance: RedditMcpAgent, state) => {
      const { applyRedditSchema } = await import(
        "../src/agents/platforms/reddit/schema"
      );
      applyRedditSchema(state.storage.sql);

      const tables = state.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type='table'
             AND name IN ('rate_limits', 'call_cache', 'posted_externals')
           ORDER BY name`,
        )
        .toArray()
        .map((r) => r.name);

      expect(tables).toEqual([
        "call_cache",
        "posted_externals",
        "rate_limits",
      ]);
    });
  });
});
