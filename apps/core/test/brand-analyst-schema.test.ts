import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyBrandAnalystSchema } from "../src/agents/brand-analyst/schema";
import type { BrandAnalyst } from "../src/agents/brand-analyst/BrandAnalyst";

/**
 * Smoke tests for the BrandAnalyst DO's SQLite schema bootstrap.
 *
 * Mirrors `hog-schema.test.ts` — drives `applyBrandAnalystSchema` directly
 * because McpAgent's `super.onStart()` rejects non-transport DO names.
 */

describe("BrandAnalyst schema", () => {
  it("applies all 2 tables on onStart", async () => {
    const stub = env.BRAND_ANALYST.getByName("brand-analyst-schema-1");
    await runInDurableObject(stub, async (_instance: BrandAnalyst, state) => {
      applyBrandAnalystSchema(state.storage.sql);
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

      expect(tables).toEqual([
        "competitor_analyses",
        "positioning_suggestions",
      ]);
    });
  });

  it("competitor_analyses insert + select round-trip", async () => {
    const stub = env.BRAND_ANALYST.getByName("brand-analyst-schema-2");
    await runInDurableObject(stub, async (_instance: BrandAnalyst, state) => {
      applyBrandAnalystSchema(state.storage.sql);
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO competitor_analyses
           (id, competitor, voice, themes_json, channels_json, analyzed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        "analysis-1",
        "Buffer",
        "earnest indie",
        JSON.stringify(["scheduling", "remote work"]),
        JSON.stringify(["x", "linkedin"]),
        1700_000_000,
      );
      const rows = sql
        .exec<{ competitor: string; voice: string; themes_json: string }>(
          "SELECT competitor, voice, themes_json FROM competitor_analyses WHERE id = ?",
          "analysis-1",
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.competitor).toBe("Buffer");
      expect(JSON.parse(rows[0]!.themes_json)).toEqual([
        "scheduling",
        "remote work",
      ]);
    });
  });

  it("indexes on competitor_analyses + positioning_suggestions present", async () => {
    const stub = env.BRAND_ANALYST.getByName("brand-analyst-schema-3");
    await runInDurableObject(stub, async (_instance: BrandAnalyst, state) => {
      applyBrandAnalystSchema(state.storage.sql);
      const idxCompetitor = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='competitor_analyses'",
        )
        .toArray()
        .map((r) => r.name);
      const idxPositioning = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='positioning_suggestions'",
        )
        .toArray()
        .map((r) => r.name);
      expect(idxCompetitor).toContain("idx_competitor_analyses_analyzed_at");
      expect(idxPositioning).toContain("idx_positioning_created_at");
    });
  });
});
