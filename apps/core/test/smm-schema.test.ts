import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applySmmSchema } from "../src/agents/social-media-manager/schema";
import type { SMM } from "../src/agents/social-media-manager/SocialMediaMgr";

describe("applySmmSchema", () => {
  it("creates threads_inbox + drafts tables idempotently", async () => {
    const id = env.SMM.idFromName("smm-schema-test");
    await runInDurableObject<SMM, void>(env.SMM.get(id), async (_inst, state) => {
      applySmmSchema(state.storage.sql);
      applySmmSchema(state.storage.sql);   // idempotent

      const tables = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .toArray()
        .map((r) => r.name);

      expect(tables).toContain("threads_inbox");
      expect(tables).toContain("drafts");
    });
  });

  it("threads_inbox accepts row with judge_score null", async () => {
    const id = env.SMM.idFromName("smm-schema-test-inbox");
    await runInDurableObject<SMM, void>(env.SMM.get(id), async (_inst, state) => {
      applySmmSchema(state.storage.sql);
      state.storage.sql.exec(
        `INSERT INTO threads_inbox
           (id, external_id, platform, content, discovered_at, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        "t1", "ext-1", "x", "hello world", Date.now(), "pending",
      );
      const rows = state.storage.sql
        .exec("SELECT id, judge_score, status FROM threads_inbox")
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "t1", judge_score: null, status: "pending" });
    });
  });

  it("drafts accepts row with thread_id or plan_item_id (either nullable)", async () => {
    const id = env.SMM.idFromName("smm-schema-test-drafts");
    await runInDurableObject<SMM, void>(env.SMM.get(id), async (_inst, state) => {
      applySmmSchema(state.storage.sql);
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO drafts (id, kind, channel, thread_id, body, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        "d1", "reply", "x", "t1", "drafted reply text", "ready", now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO drafts (id, kind, channel, plan_item_id, body, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        "d2", "post", "reddit", "pi1", "drafted post text", "failed", now, now,
      );
      const rows = state.storage.sql
        .exec("SELECT id, kind, channel, thread_id, plan_item_id FROM drafts ORDER BY id")
        .toArray();
      expect(rows).toHaveLength(2);
    });
  });
});
