import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCommunityManagerSchema } from "../src/agents/community-manager/schema";
import type { CommunityManager } from "../src/agents/community-manager/CommunityManager";

/**
 * Smoke tests for the CommunityManager DO's SQLite schema bootstrap.
 *
 * Mirrors `hog-schema.test.ts` — drives `applyCommunityManagerSchema`
 * directly because McpAgent's `super.onStart()` rejects non-transport DO
 * names.
 */

describe("CommunityManager schema", () => {
  it("applies the single community_findings table on onStart", async () => {
    const stub = env.COMMUNITY_MGR.getByName("community-mgr-schema-1");
    await runInDurableObject(
      stub,
      async (_instance: CommunityManager, state) => {
        applyCommunityManagerSchema(state.storage.sql);
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

        expect(tables).toEqual(["community_findings"]);
      },
    );
  });

  it("community_findings insert + select round-trip", async () => {
    const stub = env.COMMUNITY_MGR.getByName("community-mgr-schema-2");
    await runInDurableObject(
      stub,
      async (_instance: CommunityManager, state) => {
        applyCommunityManagerSchema(state.storage.sql);
        const sql = state.storage.sql;
        sql.exec(
          `INSERT INTO community_findings
             (platform, kind, finding, json, observed_at)
           VALUES (?, ?, ?, ?, ?)`,
          "x",
          "pulse",
          "indie audience excited about local-first AI",
          JSON.stringify({ sentiment: "positive", topics: ["local-first AI"] }),
          1700_000_000,
        );
        const rows = sql
          .exec<{
            platform: string;
            kind: string;
            finding: string;
            json: string;
          }>(
            "SELECT platform, kind, finding, json FROM community_findings WHERE platform = ?",
            "x",
          )
          .toArray();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.kind).toBe("pulse");
        expect(JSON.parse(rows[0]!.json).sentiment).toBe("positive");
      },
    );
  });

  it("indexes on community_findings present", async () => {
    const stub = env.COMMUNITY_MGR.getByName("community-mgr-schema-3");
    await runInDurableObject(
      stub,
      async (_instance: CommunityManager, state) => {
        applyCommunityManagerSchema(state.storage.sql);
        const indexes = state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='community_findings'",
          )
          .toArray()
          .map((r) => r.name);
        expect(indexes).toContain("idx_community_findings_kind_observed");
        expect(indexes).toContain("idx_community_findings_platform_observed");
      },
    );
  });
});
