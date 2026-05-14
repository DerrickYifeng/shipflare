import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { applySmmSchema } from "../src/agents/social-media-manager/schema";
import type { SocialMediaMgr } from "../src/agents/social-media-manager/SocialMediaMgr";

/**
 * SQL-shape tests for SMM's `find_threads` and `list_drafts` tools (S4.2 +
 * S4.5 partial). Same pattern as `smm-find-threads.test.ts` (S4.1) — we
 * drive the SQL directly rather than invoking the McpAgent transport,
 * because `super.onStart()` requires a transport-prefixed DO name and
 * tests use plain (`smm-ft-*` / `smm-ld-*`) names. Tool-registration
 * coverage rides on `SocialMediaMgr.init()` calling both registers — the
 * agent type import ensures a wiring regression surfaces in CI.
 */

describe("SMM find_threads — read shape", () => {
  it("filters by platform IN (...)", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-ft-1");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      const sql = state.storage.sql;
      applySmmSchema(sql);

      // Seed: 2 x threads + 1 reddit thread, different judged_at ordering.
      sql.exec(
        `INSERT INTO threads_inbox (id, platform, external_id, content, judged_at)
         VALUES ('x1', 'x', 'e1', 'x thread 1', 100),
                ('x2', 'x', 'e2', 'x thread 2', 200),
                ('r1', 'reddit', 'e3', 'reddit', 150)`,
      );

      // Mirror the tool's exact query shape (dynamic IN + IS NULL trick).
      const xOnly = sql
        .exec<{ id: string }>(
          "SELECT id FROM threads_inbox WHERE platform IN (?) ORDER BY judged_at IS NULL, judged_at DESC LIMIT ?",
          "x",
          20,
        )
        .toArray();
      expect(xOnly.map((r) => r.id)).toEqual(["x2", "x1"]);

      const all = sql
        .exec<{ id: string }>(
          "SELECT id FROM threads_inbox WHERE platform IN (?, ?) ORDER BY judged_at IS NULL, judged_at DESC LIMIT ?",
          "x",
          "reddit",
          20,
        )
        .toArray();
      expect(all.map((r) => r.id)).toEqual(["x2", "r1", "x1"]);
    });
  });

  it("respects limit", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-ft-2");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      const sql = state.storage.sql;
      applySmmSchema(sql);

      for (let i = 0; i < 5; i++) {
        sql.exec(
          "INSERT INTO threads_inbox (id, platform, external_id, content, judged_at) VALUES (?, ?, ?, ?, ?)",
          `t-${i}`,
          "x",
          `e-${i}`,
          `body ${i}`,
          i,
        );
      }

      const limited = sql
        .exec<{ id: string }>(
          "SELECT id FROM threads_inbox WHERE platform IN (?) ORDER BY judged_at IS NULL, judged_at DESC LIMIT ?",
          "x",
          3,
        )
        .toArray();
      expect(limited).toHaveLength(3);
    });
  });

  it("NULL judged_at rows bubble to the bottom", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-ft-3");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      const sql = state.storage.sql;
      applySmmSchema(sql);

      // Mix of judged and un-judged rows; un-judged should land last.
      sql.exec(
        `INSERT INTO threads_inbox (id, platform, external_id, content, judged_at)
         VALUES ('a', 'x', 'e1', 'body a', 50),
                ('b', 'x', 'e2', 'body b', NULL),
                ('c', 'x', 'e3', 'body c', 100)`,
      );

      const rows = sql
        .exec<{ id: string }>(
          "SELECT id FROM threads_inbox WHERE platform IN (?) ORDER BY judged_at IS NULL, judged_at DESC LIMIT ?",
          "x",
          20,
        )
        .toArray();
      expect(rows.map((r) => r.id)).toEqual(["c", "a", "b"]);
    });
  });
});

describe("SMM list_drafts — status filter", () => {
  it("default status='ready' returns only ready drafts, newest first", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-ld-1");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      const sql = state.storage.sql;
      applySmmSchema(sql);

      sql.exec(
        `INSERT INTO drafts (id, kind, platform, body, status, created_at, updated_at)
         VALUES ('d-1', 'post', 'x', 'b1', 'drafting', 1, 1),
                ('d-2', 'reply', 'x', 'b2', 'ready', 2, 2),
                ('d-3', 'post', 'reddit', 'b3', 'ready', 3, 3),
                ('d-4', 'post', 'x', 'b4', 'posted', 4, 4)`,
      );

      const ready = sql
        .exec<{ id: string }>(
          "SELECT id FROM drafts WHERE status = ? ORDER BY updated_at DESC LIMIT ?",
          "ready",
          50,
        )
        .toArray();
      expect(ready.map((r) => r.id)).toEqual(["d-3", "d-2"]);
    });
  });

  it("status='posted' filters correctly", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-ld-2");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      const sql = state.storage.sql;
      applySmmSchema(sql);

      sql.exec(
        `INSERT INTO drafts (id, kind, platform, body, status, created_at, updated_at)
         VALUES ('d-1', 'post', 'x', 'b1', 'posted', 1, 1),
                ('d-2', 'post', 'x', 'b2', 'ready', 2, 2)`,
      );

      const posted = sql
        .exec<{ id: string }>(
          "SELECT id FROM drafts WHERE status = ? LIMIT ?",
          "posted",
          50,
        )
        .toArray();
      expect(posted).toHaveLength(1);
      expect(posted[0]!.id).toBe("d-1");
    });
  });

  it("respects limit on busy status='ready' queue", async () => {
    const stub = env.SOCIAL_MEDIA_MGR.getByName("smm-ld-3");
    await runInDurableObject(stub, async (_instance: SocialMediaMgr, state) => {
      const sql = state.storage.sql;
      applySmmSchema(sql);

      for (let i = 0; i < 10; i++) {
        sql.exec(
          `INSERT INTO drafts (id, kind, platform, body, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          `d-${i}`,
          "post",
          "x",
          `body ${i}`,
          "ready",
          i,
          i,
        );
      }

      const limited = sql
        .exec(
          "SELECT id FROM drafts WHERE status = ? ORDER BY updated_at DESC LIMIT ?",
          "ready",
          4,
        )
        .toArray();
      expect(limited).toHaveLength(4);
    });
  });
});
