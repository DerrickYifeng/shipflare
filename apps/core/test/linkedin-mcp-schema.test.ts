import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyLinkedInSchema } from "../src/agents/platforms/linkedin/schema";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Smoke tests for LinkedInMcpAgent's SQLite schema bootstrap (P2-E).
 *
 * Same approach as `x-mcp-schema.test.ts` / `reddit-mcp-schema.test.ts`:
 * we BORROW a CMO DO's SqlStorage to drive `applyLinkedInSchema(...)` in
 * isolation. The schema bootstrap only cares about a `SqlStorage` shape —
 * it doesn't care which class owns the storage. The CMO DO instance
 * itself is never touched (no onStart, no method calls).
 *
 * Why not use `env.LINKEDIN_MCP.getByName(...)` directly: the binding is
 * declared in wrangler.jsonc but the parent McpAgent's transport-init
 * still throws on non-transport DO names — we'd be fighting the same
 * machinery that x-mcp-schema works around. Keep the pattern consistent
 * across platform MCPs.
 */

const LINKEDIN_TABLES = ["call_cache", "posted_externals", "rate_limits"] as const;

describe("LinkedInMcpAgent schema", () => {
  it("applies all 3 tables", async () => {
    const stub = env.CMO.getByName("linkedin-schema-test-user-1");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyLinkedInSchema(state.storage.sql);
      const tables = state.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type='table'
             AND name IN ('rate_limits', 'call_cache', 'posted_externals')
           ORDER BY name`,
        )
        .toArray()
        .map((r) => r.name);

      expect(tables).toEqual([...LINKEDIN_TABLES]);
    });
  });

  it("call_cache has idx_call_cache_expires for TTL sweeps", async () => {
    const stub = env.CMO.getByName("linkedin-schema-test-user-2");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyLinkedInSchema(state.storage.sql);
      const indexes = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='call_cache'",
        )
        .toArray()
        .map((r) => r.name);
      expect(indexes).toContain("idx_call_cache_expires");
    });
  });

  it("posted_externals upsert by external_id (PK) — idempotent on retry", async () => {
    const stub = env.CMO.getByName("linkedin-schema-test-user-3");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyLinkedInSchema(sql);

      // LinkedIn external_ids are share / ugcPost URNs.
      sql.exec(
        `INSERT INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        "urn:li:share:7000000000000000001",
        "post",
        "lead",
        1000,
        '{"first":true}',
      );
      sql.exec(
        `INSERT OR REPLACE INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        "urn:li:share:7000000000000000001",
        "post",
        "lead",
        2000,
        '{"second":true}',
      );

      const rows = sql
        .exec<{ external_id: string; posted_at: number; json: string }>(
          "SELECT external_id, posted_at, json FROM posted_externals",
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.posted_at).toBe(2000);
      expect(rows[0]!.json).toBe('{"second":true}');
    });
  });

  it("rate_limits stores per-endpoint budget keyed on endpoint", async () => {
    const stub = env.CMO.getByName("linkedin-schema-test-user-4");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyLinkedInSchema(sql);

      sql.exec(
        "INSERT INTO rate_limits (endpoint, remaining, reset_at) VALUES (?, ?, ?)",
        "/v2/ugcPosts",
        500,
        9_999_999,
      );

      const row = sql
        .exec<{ remaining: number }>(
          "SELECT remaining FROM rate_limits WHERE endpoint = ?",
          "/v2/ugcPosts",
        )
        .one();
      expect(row.remaining).toBe(500);
    });
  });
});
