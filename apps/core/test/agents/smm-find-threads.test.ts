import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
      const tools = instance.getTools();
      const res = await tools.find_threads!.execute!(
        { platforms: ["x"], status: "pending", limit: 10 },
        { experimental_context: { env: instance.bindings, userId } } as never,
      );
      const r = res as { threads: Array<{ id: string }> };
      // ORDER BY judged_at DESC; platform IN ('x') only; status='pending' only
      // → t2 (judged_at=3000), t1 (judged_at=1000). NOT t3 (reddit). NOT t4 (drafted).
      expect(r.threads.map((t) => t.id)).toEqual(["t2", "t1"]);
    });
  });

  it("defaults to all platforms + status='pending' + limit 20", async () => {
    const userId = "smm-ft-2";
    const stub = env.SMM.get(env.SMM.idFromName(userId));
    await runInDurableObject<SMM, void>(stub, async (_inst, state) => applySmmSchema(state.storage.sql));
    await runInDurableObject<SMM, void>(stub, async (instance) => {
      const r = await instance.getTools().find_threads!.execute!(
        {},
        { experimental_context: { env: instance.bindings, userId } } as never,
      );
      expect((r as { threads: unknown[] }).threads).toEqual([]);
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
      const r = await instance.getTools().find_threads!.execute!(
        { limit: 5 },
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
