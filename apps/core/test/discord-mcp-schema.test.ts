import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyDiscordSchema } from "../src/agents/platforms/discord/schema";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Smoke tests for DiscordMcpAgent's SQLite schema bootstrap (P2-E).
 *
 * Same borrow-a-CMO-DO pattern as the X / Reddit / LinkedIn / HN schema
 * tests. The schema is identical in shape to the other platforms — only
 * the `external_id` semantics differ (Discord snowflake IDs instead of
 * tweet ids / Reddit fullnames / LinkedIn URNs).
 */

const DISCORD_TABLES = ["call_cache", "posted_externals", "rate_limits"] as const;

describe("DiscordMcpAgent schema", () => {
  it("applies all 3 tables", async () => {
    const stub = env.CMO.getByName("discord-schema-test-user-1");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyDiscordSchema(state.storage.sql);
      const tables = state.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type='table'
             AND name IN ('rate_limits', 'call_cache', 'posted_externals')
           ORDER BY name`,
        )
        .toArray()
        .map((r) => r.name);

      expect(tables).toEqual([...DISCORD_TABLES]);
    });
  });

  it("call_cache has idx_call_cache_expires for TTL sweeps", async () => {
    const stub = env.CMO.getByName("discord-schema-test-user-2");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyDiscordSchema(state.storage.sql);
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
    const stub = env.CMO.getByName("discord-schema-test-user-3");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyDiscordSchema(sql);

      // Discord snowflake IDs are 17-20 digit decimal strings.
      sql.exec(
        `INSERT INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        "1234567890123456789",
        "post",
        "lead",
        1000,
        '{"first":true}',
      );
      sql.exec(
        `INSERT OR REPLACE INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        "1234567890123456789",
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
    const stub = env.CMO.getByName("discord-schema-test-user-4");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyDiscordSchema(sql);

      sql.exec(
        "INSERT INTO rate_limits (endpoint, remaining, reset_at) VALUES (?, ?, ?)",
        "POST /channels/{channel.id}/messages",
        5,
        9_999_999,
      );

      const row = sql
        .exec<{ remaining: number }>(
          "SELECT remaining FROM rate_limits WHERE endpoint = ?",
          "POST /channels/{channel.id}/messages",
        )
        .one();
      expect(row.remaining).toBe(5);
    });
  });
});
