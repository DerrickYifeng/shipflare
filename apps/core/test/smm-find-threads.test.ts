import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { applySmmSchema } from "../src/agents/social-media-manager/schema";
import type { SocialMediaMgr } from "../src/agents/social-media-manager/SocialMediaMgr";

/**
 * Persistence-shape tests for SMM's `find_threads_via_xai` tool.
 *
 * Same pattern as `smm-schema.test.ts` (S4.0) and `hog-strategic-path.test.ts`
 * (S3.1): we drive the tool's SQL writes directly rather than invoking the
 * McpAgent transport, because `super.onStart()` requires a transport-prefixed
 * DO name to bootstrap the MCP wiring and tests use plain (`smm-find-*`)
 * names. The Anthropic call + platform-MCP call inside the tool are
 * environmentally non-deterministic / not yet implemented (S5); here we
 * cover the SQL persistence + scoping + index-usage invariants that come
 * from the tool's body.
 *
 * Tool-registration coverage rides on SMM's `init()` calling
 * `registerFindThreadsViaXaiTool(this)` — this file imports the agent type
 * so a typecheck regression in the wiring surfaces in CI.
 */
describe("SMM find_threads_via_xai — persistence shape", () => {
  it("threads_inbox upsert via INSERT OR REPLACE on external_id collision", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-find-1");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      const sql = state.storage.sql;
      applySmmSchema(sql);

      // Simulate two inserts of the same external_id (judged twice over time).
      // PK is `id` (UUID), not `external_id`, so two rows coexist — that's
      // intentional. Tools can dedupe by external_id at query time if needed.
      const id1 = "uuid-1";
      const id2 = "uuid-2";
      sql.exec(
        `INSERT OR REPLACE INTO threads_inbox (id, platform, external_id, author, content, score, judged_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id1,
        "x",
        "extern-100",
        "alice",
        "first body",
        0.6,
        1,
        1000,
      );
      sql.exec(
        `INSERT OR REPLACE INTO threads_inbox (id, platform, external_id, author, content, score, judged_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id2,
        "x",
        "extern-100",
        "alice",
        "updated body",
        0.8,
        2,
        2000,
      );

      const rows = sql
        .exec<{ external_id: string; score: number }>(
          "SELECT external_id, score FROM threads_inbox WHERE external_id = ? ORDER BY judged_at",
          "extern-100",
        )
        .toArray();
      expect(rows).toHaveLength(2);
      expect(rows[1]!.score).toBe(0.8);
    });
  });

  it("threads scoped per platform", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-find-2");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      const sql = state.storage.sql;
      applySmmSchema(sql);

      sql.exec(
        `INSERT INTO threads_inbox (id, platform, external_id, content, judged_at)
         VALUES (?, ?, ?, ?, ?)`,
        "x-1",
        "x",
        "x-100",
        "x thread",
        1,
      );
      sql.exec(
        `INSERT INTO threads_inbox (id, platform, external_id, content, judged_at)
         VALUES (?, ?, ?, ?, ?)`,
        "r-1",
        "reddit",
        "r-200",
        "reddit thread",
        2,
      );

      const xRows = sql
        .exec("SELECT * FROM threads_inbox WHERE platform = 'x'")
        .toArray();
      expect(xRows).toHaveLength(1);
      const redditRows = sql
        .exec("SELECT * FROM threads_inbox WHERE platform = 'reddit'")
        .toArray();
      expect(redditRows).toHaveLength(1);
    });
  });

  it("idx_inbox_platform_judged accelerates the find_threads query shape", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-find-3");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      const sql = state.storage.sql;
      applySmmSchema(sql);

      // Seed 50 rows
      for (let i = 0; i < 50; i++) {
        sql.exec(
          `INSERT INTO threads_inbox (id, platform, external_id, content, judged_at)
           VALUES (?, ?, ?, ?, ?)`,
          `r-${i}`,
          i % 2 === 0 ? "x" : "reddit",
          `ext-${i}`,
          `body-${i}`,
          i,
        );
      }

      // Verify EXPLAIN QUERY PLAN uses the index
      const planRows = sql
        .exec(
          "EXPLAIN QUERY PLAN SELECT * FROM threads_inbox WHERE platform = 'x' ORDER BY judged_at DESC LIMIT 20",
        )
        .toArray();
      const plan = JSON.stringify(planRows);
      expect(plan).toContain("idx_inbox_platform_judged");
    });
  });
});
