import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applySmmSchema } from "../../src/agents/social-media-manager/schema";
import type { SMM } from "../../src/agents/social-media-manager/SocialMediaMgr";

describe("SMM tool find_threads", () => {
  it("returns rows from threads_inbox ordered by judged_at DESC with platform + status filters", async () => {
    const userId = "smm-ft-1";
    const stub = env.SMM.get(env.SMM.idFromName(userId));
    await runInDurableObject<SMM, void>(stub, async (_inst, state) => {
      applySmmSchema(state.storage.sql);
      const insert = (id: string, plat: string, judgedAt: number | null, status: string) =>
        state.storage.sql.exec(
          `INSERT INTO threads_inbox (id, external_id, platform, content, judge_score, judged_at, discovered_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id, `ext-${id}`, plat, "content", 0.7, judgedAt, Date.now(), status,
        );
      insert("t1", "x", 1000, "pending");
      insert("t2", "x", 3000, "pending");
      insert("t3", "reddit", 2000, "pending");
      insert("t4", "x", 4000, "drafted");
    });

    await runInDurableObject<SMM, void>(stub, async (instance) => {
      const tool = instance.getTools().find_threads!;
      // Route through inputSchema so Zod defaults are applied — this is the
      // boundary the `ai` SDK uses (safeValidateTypes → safeParseAsync) before
      // invoking execute(). Calling execute() directly bypasses validation.
      const parsed = (tool.inputSchema as z.ZodTypeAny).parse({
        platforms: ["x"], status: "pending", limit: 10,
      });
      const res = await tool.execute!(
        parsed,
        { experimental_context: { env: instance.bindings, userId } } as never,
      );
      const r = res as { threads: Array<{ id: string }> };
      // ORDER BY judged_at DESC; platform IN ('x') only; status='pending' only
      // → t2 (judged_at=3000), t1 (judged_at=1000). NOT t3 (reddit). NOT t4 (drafted).
      expect(r.threads.map((t) => t.id)).toEqual(["t2", "t1"]);
    });
  });

  it("defaults: all platforms + status='pending' + limit 20", async () => {
    const userId = "smm-ft-2";
    const stub = env.SMM.get(env.SMM.idFromName(userId));
    await runInDurableObject<SMM, void>(stub, async (_inst, state) => {
      applySmmSchema(state.storage.sql);
      const insert = (id: string, plat: string, status: string) =>
        state.storage.sql.exec(
          `INSERT INTO threads_inbox (id, external_id, platform, content, judge_score, judged_at, discovered_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id, `ext-${id}`, plat, "c", 0.5, 1000, Date.now(), status,
        );
      insert("a", "x", "pending");
      insert("b", "reddit", "pending");
      insert("c", "x", "drafted");
    });
    await runInDurableObject<SMM, void>(stub, async (instance) => {
      const tool = instance.getTools().find_threads!;
      // {} → Zod applies status='pending', limit=20, platforms stays undefined
      // (optional, falls back to ["x","reddit"] inside execute()).
      const parsed = (tool.inputSchema as z.ZodTypeAny).parse({});
      const r = await tool.execute!(
        parsed,
        { experimental_context: { env: instance.bindings, userId } } as never,
      );
      const ids = (r as { threads: Array<{ id: string }> }).threads.map((t) => t.id).sort();
      // 'a' (pending/x) + 'b' (pending/reddit) match defaults. 'c' (drafted) excluded.
      expect(ids).toEqual(["a", "b"]);
    });
  });

  it("returns mapped row shape (camelCase keys)", async () => {
    const userId = "smm-ft-3";
    const stub = env.SMM.get(env.SMM.idFromName(userId));
    await runInDurableObject<SMM, void>(stub, async (_inst, state) => {
      applySmmSchema(state.storage.sql);
      state.storage.sql.exec(
        `INSERT INTO threads_inbox (id, external_id, platform, author, content, judge_score, judged_at, discovered_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "t1", "ext-1", "x", "alice", "hello", 0.9, 5000, Date.now(), "pending",
      );
    });
    await runInDurableObject<SMM, void>(stub, async (instance) => {
      const tool = instance.getTools().find_threads!;
      const parsed = (tool.inputSchema as z.ZodTypeAny).parse({ limit: 5 });
      const r = await tool.execute!(
        parsed,
        { experimental_context: { env: instance.bindings, userId } } as never,
      );
      const threads = (r as { threads: Array<{
        id: string; externalId: string; platform: string; author: string | null;
        content: string; judgeScore: number | null; judgedAt: number | null;
      }> }).threads;
      expect(threads).toHaveLength(1);
      expect(threads[0]).toMatchObject({
        id: "t1", externalId: "ext-1", platform: "x", author: "alice",
        content: "hello", judgeScore: 0.9, judgedAt: 5000,
      });
    });
  });
});
