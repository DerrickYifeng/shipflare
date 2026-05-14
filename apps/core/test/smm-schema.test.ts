import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applySmmSchema } from "../src/agents/social-media-manager/schema";
import type { SocialMediaMgr } from "../src/agents/social-media-manager/SocialMediaMgr";

/**
 * Smoke tests for the SocialMediaMgr DO's SQLite schema bootstrap.
 *
 * Same pattern as `hog-schema.test.ts` (S3.0) and `cmo-schema.test.ts`
 * (S2.0): we drive `applySmmSchema` directly rather than
 * `instance.onStart()` because McpAgent's `super.onStart()` calls
 * `getTransportType()` which reads a transport prefix
 * (`sse:` / `streamable-http:` / `rpc:`) from the DO name and throws on
 * non-transport names. SMM.onStart runs `applySmmSchema` BEFORE the super
 * call precisely so the schema can be verified in isolation here.
 *
 * Schema queries exclude:
 *   - `sqlite_%` — SQLite's own metadata
 *   - `_cf_%` — workerd's internal bookkeeping
 *   - `cf_agents_%` / `cf_agent_%` — Agents framework state tables (runs,
 *     queues, schedules, MCP server registry; the framework writes these
 *     lazily on first use, not at construction, so they may or may not
 *     exist when we read sqlite_master).
 */

describe("SocialMediaMgr schema", () => {
  it("applies all 4 tables", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-schema-test-user-1");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      applySmmSchema(state.storage.sql);
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
        "drafts",
        "posted",
        "threads_inbox",
        "voice_audit",
      ]);
    });
  });

  it("drafts table accepts null conversation_id (cron-initiated)", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-schema-test-user-2");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      const sql = state.storage.sql;
      applySmmSchema(sql);

      sql.exec(
        `INSERT INTO drafts
           (conversation_id, id, kind, plan_item_id, platform, body, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        null,
        "d1",
        "post",
        "pi-1",
        "x",
        "test body",
        "drafting",
        1,
        1,
      );

      const row = sql
        .exec<{ conversation_id: string | null; kind: string }>(
          "SELECT conversation_id, kind FROM drafts WHERE id = 'd1'",
        )
        .one();
      expect(row.conversation_id).toBeNull();
      expect(row.kind).toBe("post");
    });
  });

  it("threads_inbox has idx_inbox_platform_judged", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-schema-test-user-3");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      applySmmSchema(state.storage.sql);
      const indexes = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='threads_inbox'",
        )
        .toArray()
        .map((r) => r.name);
      expect(indexes).toContain("idx_inbox_platform_judged");
    });
  });

  it("drafts has idx_drafts_status + idx_drafts_plan_item", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-schema-test-user-4");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      applySmmSchema(state.storage.sql);
      const indexes = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='drafts'",
        )
        .toArray()
        .map((r) => r.name);
      expect(indexes).toEqual(
        expect.arrayContaining(["idx_drafts_status", "idx_drafts_plan_item"]),
      );
    });
  });
});
