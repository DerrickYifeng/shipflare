import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCopywriterSchema } from "../src/agents/copywriter/schema";
import type { Copywriter } from "../src/agents/copywriter/Copywriter";

/**
 * Smoke tests for the Copywriter DO's SQLite schema bootstrap.
 *
 * Same pattern as `hog-schema.test.ts`: we drive `applyCopywriterSchema`
 * directly rather than `instance.onStart()` because McpAgent's
 * `super.onStart()` calls `getTransportType()` which reads a transport
 * prefix from the DO name and throws on non-transport names. Copywriter
 * runs `applyCopywriterSchema` BEFORE the super call precisely so the
 * schema can be verified in isolation here.
 *
 * Schema queries exclude:
 *   - `sqlite_%` — SQLite's own metadata
 *   - `_cf_%` — workerd's internal bookkeeping
 *   - `cf_agents_%` / `cf_agent_%` — Agents framework state tables
 */

describe("Copywriter schema", () => {
  it("applies all 2 tables on onStart", async () => {
    const stub = env.COPYWRITER.getByName("copywriter-schema-test-user-1");
    await runInDurableObject(stub, async (_instance: Copywriter, state) => {
      applyCopywriterSchema(state.storage.sql);
      const tables = state.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type='table'
             AND name NOT LIKE 'sqlite_%'
             AND name NOT LIKE '_cf_%'
             AND name NOT LIKE 'cf_agents_%'
             AND name NOT LIKE 'cf_agent_%'
           ORDER BY name`,
        )
        .toArray()
        .map((r) => r.name);

      expect(tables).toEqual(["copy_drafts", "voice_lessons"]);
    });
  });

  it("copy_drafts insert + select round-trip", async () => {
    const stub = env.COPYWRITER.getByName("copywriter-schema-test-user-2");
    await runInDurableObject(stub, async (_instance: Copywriter, state) => {
      applyCopywriterSchema(state.storage.sql);
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO copy_drafts (id, kind, brief, output, voice, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        "draft-1",
        "headline",
        "launch announcement",
        "Ship faster, debug less.",
        "casual",
        1700_000_000,
      );
      const rows = sql
        .exec<{ id: string; kind: string; output: string }>(
          "SELECT id, kind, output FROM copy_drafts WHERE id = ?",
          "draft-1",
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe("headline");
      expect(rows[0]!.output).toBe("Ship faster, debug less.");
    });
  });

  it("copy_drafts index on (kind, created_at) is present", async () => {
    const stub = env.COPYWRITER.getByName("copywriter-schema-test-user-3");
    await runInDurableObject(stub, async (_instance: Copywriter, state) => {
      applyCopywriterSchema(state.storage.sql);
      const indexes = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='copy_drafts'",
        )
        .toArray()
        .map((r) => r.name);
      expect(indexes).toContain("idx_copy_drafts_kind_created");
    });
  });
});
