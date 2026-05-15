import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyRedditSchema } from "../src/agents/platforms/reddit/schema";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Smoke tests for RedditMcpAgent's SQLite schema bootstrap (S5.2).
 *
 * The REDDIT_MCP binding is intentionally NOT wired in wrangler.jsonc
 * yet (S5.3 uncomments it alongside X_MCP under migration tag v4). To
 * validate the schema in isolation we BORROW an existing DO binding
 * (CMO here) and drive `applyRedditSchema(state.storage.sql)` against
 * its SqlStorage handle.
 *
 * Same approach as `x-mcp-schema.test.ts` — `applyRedditSchema` only
 * cares about a `SqlStorage` shape; it doesn't care which class the
 * storage belongs to. The CMO DO instance isn't touched (we don't
 * call its onStart / methods), only its raw SqlStorage handle, which
 * is per-DO-instance and isolated.
 *
 * Once S5.3 lands the REDDIT_MCP binding, future tests will use
 * `env.REDDIT_MCP.getByName(...)` directly.
 */

const REDDIT_TABLES = [
  "call_cache",
  "posted_externals",
  "rate_limits",
] as const;

describe("RedditMcpAgent schema", () => {
  it("applies all 3 tables", async () => {
    const stub = env.CMO.getByName("reddit-schema-test-user-1");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
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

      expect(tables).toEqual([...REDDIT_TABLES]);
    });
  });

  it("call_cache has idx_call_cache_expires for TTL sweeps", async () => {
    const stub = env.CMO.getByName("reddit-schema-test-user-2");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyRedditSchema(state.storage.sql);
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
    const stub = env.CMO.getByName("reddit-schema-test-user-3");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyRedditSchema(sql);

      // Reddit fullnames: `t3_<id>` for submissions, `t1_<id>` for
      // comments. The schema stores them verbatim — no parsing here.
      sql.exec(
        `INSERT INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        "t3_abc123",
        "post",
        "lead",
        1000,
        '{"name":"t3_abc123","first":true}',
      );
      sql.exec(
        `INSERT OR REPLACE INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        "t3_abc123",
        "post",
        "lead",
        2000,
        '{"name":"t3_abc123","second":true}',
      );

      const rows = sql
        .exec<{
          external_id: string;
          posted_at: number;
          json: string;
        }>("SELECT external_id, posted_at, json FROM posted_externals")
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.posted_at).toBe(2000);
      expect(rows[0]!.json).toBe('{"name":"t3_abc123","second":true}');
    });
  });

  it("rate_limits stores per-endpoint budget keyed on endpoint", async () => {
    const stub = env.CMO.getByName("reddit-schema-test-user-4");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyRedditSchema(sql);

      sql.exec(
        "INSERT INTO rate_limits (endpoint, remaining, reset_at) VALUES (?, ?, ?)",
        "/api/submit",
        60,
        9_999_999,
      );
      sql.exec(
        "INSERT INTO rate_limits (endpoint, remaining, reset_at) VALUES (?, ?, ?)",
        "/api/comment",
        60,
        9_999_999,
      );

      const row = sql
        .exec<{ remaining: number }>(
          "SELECT remaining FROM rate_limits WHERE endpoint = ?",
          "/api/submit",
        )
        .one();
      expect(row.remaining).toBe(60);
    });
  });
});
