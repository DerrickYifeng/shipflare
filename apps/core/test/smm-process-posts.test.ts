import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { applySmmSchema } from "../src/agents/social-media-manager/schema";
import { extractText } from "../src/agents/social-media-manager/lib/mcp-result";
import type { SocialMediaMgr } from "../src/agents/social-media-manager/SocialMediaMgr";

/**
 * Tests for `process_posts_batch` (S4.4):
 *   - extractText shared helper unit tests (lifted to lib/mcp-result.ts)
 *   - persistence-shape integration tests (kind='post' + plan_item_id link)
 *
 * Same pattern as `smm-process-replies.test.ts`: we drive SQL directly
 * because non-transport-prefixed DO names skip parent `McpAgent.onStart`
 * transport-init. Anthropic + CMO RPC paths aren't exercised here; that
 * coverage rides on S6's drafting-post skill port + integration tests.
 */

describe("extractText shared helper", () => {
  it("returns empty string when content missing", () => {
    expect(extractText({})).toBe("");
    expect(extractText(null)).toBe("");
    expect(extractText({ content: [] })).toBe("");
  });

  it("joins all text blocks", () => {
    const result = {
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
    };
    expect(extractText(result)).toBe("helloworld");
  });

  it("ignores non-text blocks", () => {
    const result = {
      content: [
        { type: "text", text: "good" },
        { type: "image", url: "x.png" },
        { type: "text", text: "morning" },
      ],
    };
    expect(extractText(result)).toBe("goodmorning");
  });
});

describe("SMM process_posts_batch — persistence shape", () => {
  it("draft row with kind='post' + plan_item_id link", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-pp-1");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      const sql = state.storage.sql;
      applySmmSchema(sql);

      const draftId = "d-post-1";
      const planItemId = "pi-1";
      const now = Date.now();
      sql.exec(
        `INSERT INTO drafts
           (conversation_id, id, kind, plan_item_id, platform, thread_id, body,
            why_it_works, confidence, status, audit_notes_json, created_at, updated_at)
         VALUES (?, ?, 'post', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        "conv-1",
        draftId,
        planItemId,
        "x",
        "Test post body",
        "fits voice",
        0.8,
        "ready",
        JSON.stringify({
          validation: { ok: true, reasons: [] },
          planItemId,
        }),
        now,
        now,
      );

      const row = sql
        .exec<{
          kind: string;
          plan_item_id: string;
          thread_id: string | null;
          status: string;
        }>(
          "SELECT kind, plan_item_id, thread_id, status FROM drafts WHERE id = ?",
          draftId,
        )
        .one();

      expect(row.kind).toBe("post");
      expect(row.plan_item_id).toBe(planItemId);
      expect(row.thread_id).toBeNull();
      expect(row.status).toBe("ready");
    });
  });

  it("idx_drafts_plan_item accelerates lookup by plan_item_id", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-pp-2");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      const sql = state.storage.sql;
      applySmmSchema(sql);

      // Seed
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        sql.exec(
          `INSERT INTO drafts
             (conversation_id, id, kind, plan_item_id, platform, thread_id, body,
              why_it_works, confidence, status, audit_notes_json, created_at, updated_at)
           VALUES (?, ?, 'post', ?, 'x', NULL, ?, NULL, 0, 'ready', NULL, ?, ?)`,
          "conv-1",
          `d-${i}`,
          `pi-${i}`,
          `body ${i}`,
          now + i,
          now + i,
        );
      }

      const plan = sql
        .exec(
          "EXPLAIN QUERY PLAN SELECT * FROM drafts WHERE plan_item_id = 'pi-5'",
        )
        .toArray();
      expect(JSON.stringify(plan)).toContain("idx_drafts_plan_item");
    });
  });
});
