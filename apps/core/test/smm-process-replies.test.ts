import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { applySmmSchema } from "../src/agents/social-media-manager/schema";
import {
  validateDraft,
  validatePlatformLeak,
} from "../src/agents/social-media-manager/lib/validators";
import type { SocialMediaMgr } from "../src/agents/social-media-manager/SocialMediaMgr";

/**
 * Validator unit tests + persistence-shape integration tests for
 * `process_replies_batch` (S4.3). Same pattern as `smm-find-threads-list.test.ts`
 * (S4.2) — we drive the SQL directly because non-transport-prefixed DO names
 * skip the parent `McpAgent.onStart` transport-init path. Anthropic isn't
 * called in tests; LLM-path coverage rides on the inline drafting prompt
 * landing in S6's drafting-reply skill port.
 */

describe("validateDraft (Phase 1 inline)", () => {
  it("platform-leak: X reply mentioning 'reddit' is rejected", () => {
    const r = validatePlatformLeak(
      "Check out the discussion on Reddit too",
      "x",
    );
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain("Reddit");
  });

  it("platform-leak: Reddit reply mentioning 'tweet' is rejected", () => {
    const r = validatePlatformLeak("I saw your tweet about this", "reddit");
    expect(r.ok).toBe(false);
  });

  it("X length limit: 281 chars rejected", () => {
    const longBody = "a".repeat(281);
    const r = validateDraft(longBody, "x");
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain("X length limit");
  });

  it("Reddit 10k limit: 10001 chars rejected", () => {
    const longBody = "a".repeat(10001);
    const r = validateDraft(longBody, "reddit");
    expect(r.ok).toBe(false);
  });

  it("clean X reply passes", () => {
    const r = validateDraft(
      "Great question — we use this pattern for plan_items too",
      "x",
    );
    expect(r.ok).toBe(true);
  });

  it("empty body rejected", () => {
    const r = validateDraft("   ", "x");
    expect(r.ok).toBe(false);
  });
});

describe("SMM process_replies_batch — persistence shape", () => {
  it("draft row written with status='ready' on valid reply", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-pr-1");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      const sql = state.storage.sql;
      applySmmSchema(sql);

      const draftId = "test-draft-1";
      const now = Date.now();
      sql.exec(
        `INSERT INTO drafts
           (conversation_id, id, kind, plan_item_id, platform, thread_id, body,
            why_it_works, confidence, status, audit_notes_json, created_at, updated_at)
         VALUES (?, ?, 'reply', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "conv-1",
        draftId,
        "x",
        "t-1",
        "Test reply",
        "natural fit",
        0.7,
        "ready",
        JSON.stringify({ validation: { ok: true, reasons: [] } }),
        now,
        now,
      );

      const row = sql
        .exec<{
          kind: string;
          thread_id: string;
          status: string;
          confidence: number;
        }>(
          "SELECT kind, thread_id, status, confidence FROM drafts WHERE id = ?",
          draftId,
        )
        .one();

      expect(row.kind).toBe("reply");
      expect(row.thread_id).toBe("t-1");
      expect(row.status).toBe("ready");
      expect(row.confidence).toBe(0.7);
    });
  });

  it("draft row with status='failed' captures audit_notes_json", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-pr-2");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      const sql = state.storage.sql;
      applySmmSchema(sql);

      const now = Date.now();
      sql.exec(
        `INSERT INTO drafts
           (conversation_id, id, kind, plan_item_id, platform, thread_id, body,
            why_it_works, confidence, status, audit_notes_json, created_at, updated_at)
         VALUES (?, ?, 'reply', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "conv-1",
        "d-bad",
        "x",
        "t-2",
        "Check out reddit",
        "leaked",
        0.3,
        "failed",
        JSON.stringify({
          validation: {
            ok: false,
            reasons: ["Mentions Reddit vocabulary: reddit"],
          },
        }),
        now,
        now,
      );

      const row = sql
        .exec<{ status: string; audit_notes_json: string }>(
          "SELECT status, audit_notes_json FROM drafts WHERE id = ?",
          "d-bad",
        )
        .one();

      expect(row.status).toBe("failed");
      const audit = JSON.parse(row.audit_notes_json) as {
        validation: { ok: boolean; reasons: string[] };
      };
      expect(audit.validation.ok).toBe(false);
      expect(audit.validation.reasons[0]).toContain("Reddit");
    });
  });
});
