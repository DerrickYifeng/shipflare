import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyHackerNewsSchema } from "../src/agents/platforms/hackernews/schema";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Smoke tests for HackerNewsMcpAgent's SQLite schema bootstrap (P2-E).
 *
 * HN is read-only — `posted_externals` is provisioned for shape
 * consistency with the other platform MCPs but is never written in
 * practice. We still verify it exists so future re-introductions of a
 * post tool (or a "tracked submissions" audit feature) don't have to
 * re-add the table mid-flight.
 *
 * Same borrow-a-CMO-DO pattern as the X / Reddit / LinkedIn schema tests.
 */

const HN_TABLES = ["call_cache", "posted_externals", "rate_limits"] as const;

describe("HackerNewsMcpAgent schema", () => {
  it("applies all 3 tables", async () => {
    const stub = env.CMO.getByName("hn-schema-test-user-1");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyHackerNewsSchema(state.storage.sql);
      const tables = state.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type='table'
             AND name IN ('rate_limits', 'call_cache', 'posted_externals')
           ORDER BY name`,
        )
        .toArray()
        .map((r) => r.name);

      expect(tables).toEqual([...HN_TABLES]);
    });
  });

  it("call_cache has idx_call_cache_expires for TTL sweeps", async () => {
    const stub = env.CMO.getByName("hn-schema-test-user-2");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyHackerNewsSchema(state.storage.sql);
      const indexes = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='call_cache'",
        )
        .toArray()
        .map((r) => r.name);
      expect(indexes).toContain("idx_call_cache_expires");
    });
  });

  it("call_cache round-trips Algolia search responses keyed on query", async () => {
    const stub = env.CMO.getByName("hn-schema-test-user-3");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyHackerNewsSchema(sql);

      const cacheKey = "search:shipflare:20";
      const payload = JSON.stringify({ hits: [{ objectID: "12345" }] });
      sql.exec(
        `INSERT OR REPLACE INTO call_cache (cache_key, response_json, expires_at)
         VALUES (?, ?, ?)`,
        cacheKey,
        payload,
        9_999_999,
      );

      const row = sql
        .exec<{ response_json: string }>(
          "SELECT response_json FROM call_cache WHERE cache_key = ?",
          cacheKey,
        )
        .one();
      expect(row.response_json).toBe(payload);
    });
  });
});
