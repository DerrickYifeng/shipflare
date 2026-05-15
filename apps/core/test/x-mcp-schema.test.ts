import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyXSchema } from "../src/agents/platforms/x/schema";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Smoke tests for XMcpAgent's SQLite schema bootstrap (S5.0).
 *
 * The X_MCP binding is intentionally NOT wired in wrangler.jsonc yet (S5.3
 * uncomments it along with REDDIT_MCP under migration tag v4). To validate
 * the schema in isolation we BORROW an existing DO binding (CMO here) and
 * drive `applyXSchema(state.storage.sql)` against its SqlStorage handle.
 *
 * This works because `applyXSchema` only cares about a `SqlStorage` shape —
 * it doesn't care which class the storage belongs to. The CMO DO instance
 * isn't touched (we don't call its onStart / methods), only its raw
 * SqlStorage handle, which is per-DO-instance and isolated.
 *
 * Same DO-name discipline as the CMO/HoG/SMM schema tests: non-transport
 * names skip the parent McpAgent.onStart() transport-prefix check, letting
 * us drive the bootstrap function in isolation. Once S5.3 lands the X_MCP
 * binding, future tests will use `env.X_MCP.getByName(...)` directly.
 *
 * Schema queries exclude:
 *   - `sqlite_%` — SQLite's own metadata
 *   - `_cf_%` — workerd's internal bookkeeping
 *   - `cf_agents_%` / `cf_agent_%` — Agents framework state tables
 *   - CMO's own tables (`conversations`, `founder_messages`, etc.) — present
 *     because the borrowed DO is a CMO and applies its own schema lazily
 *     via the framework. We filter to the 3 X-MCP tables explicitly.
 */

const X_TABLES = ["call_cache", "posted_externals", "rate_limits"] as const;

describe("XMcpAgent schema", () => {
  it("applies all 3 tables", async () => {
    // Borrow a CMO DO solely for its SqlStorage handle. The DO is not
    // initialized as a real CMO — we never call onStart / methods on it.
    const stub = env.CMO.getByName("x-schema-test-user-1");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
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

      expect(tables).toEqual([...X_TABLES]);
    });
  });

  it("call_cache has idx_call_cache_expires for TTL sweeps", async () => {
    const stub = env.CMO.getByName("x-schema-test-user-2");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyXSchema(state.storage.sql);
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
    const stub = env.CMO.getByName("x-schema-test-user-3");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyXSchema(sql);

      sql.exec(
        `INSERT INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        "tweet-100",
        "post",
        "social-media-manager",
        1000,
        '{"text":"first"}',
      );
      // Retry with same external_id should not duplicate — use INSERT OR REPLACE
      sql.exec(
        `INSERT OR REPLACE INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        "tweet-100",
        "post",
        "social-media-manager",
        2000,
        '{"text":"second"}',
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
      expect(rows[0]!.json).toBe('{"text":"second"}');
    });
  });

  it("rate_limits stores per-endpoint budget keyed on endpoint", async () => {
    const stub = env.CMO.getByName("x-schema-test-user-4");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyXSchema(sql);

      sql.exec(
        "INSERT INTO rate_limits (endpoint, remaining, reset_at) VALUES (?, ?, ?)",
        "/2/tweets/search/recent",
        180,
        9_999_999,
      );
      sql.exec(
        "INSERT INTO rate_limits (endpoint, remaining, reset_at) VALUES (?, ?, ?)",
        "/2/users/by/username/:username",
        500,
        9_999_999,
      );

      const row = sql
        .exec<{ remaining: number }>(
          "SELECT remaining FROM rate_limits WHERE endpoint = ?",
          "/2/tweets/search/recent",
        )
        .one();
      expect(row.remaining).toBe(180);
    });
  });
});
