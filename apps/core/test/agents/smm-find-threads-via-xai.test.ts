import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applySmmSchema } from "../../src/agents/social-media-manager/schema";
import type { SMM } from "../../src/agents/social-media-manager/SocialMediaMgr";

describe("SMM tool find_threads_via_xai", () => {
  it("persists qualifying threads to threads_inbox (dry-run input)", async () => {
    const userId = "smm-fx-1";
    const stub = env.SMM.get(env.SMM.idFromName(userId));

    // Bootstrap schema
    await runInDurableObject<SMM, void>(stub, async (_inst, state) => {
      applySmmSchema(state.storage.sql);
    });

    // Drive the tool's execute() with dry-run inputs that bypass external fetches
    await runInDurableObject<SMM, void>(stub, async (instance) => {
      const tools = instance.getTools();
      const tool = tools.find_threads_via_xai;
      expect(tool).toBeDefined();
      const result = await tool!.execute!(
        {
          platform: "x",
          intent: "engagement",
          maxResults: 5,
          context: JSON.stringify({ productName: "TestProd", productDescription: "test" }),
          _dryRunThreads: [
            { externalId: "ext-1", author: "alice", content: "I love TestProd" },
            { externalId: "ext-2", author: "bob",   content: "TestProd is meh" },
          ],
          _dryRunJudgements: [
            { keep: true,  score: 0.8, reason: "positive mention" },
            { keep: false, score: 0.2, reason: "weak signal" },
          ],
        },
        { experimental_context: { env: instance.bindings, userId } } as never,
      );
      expect(result).toMatchObject({ queued: 1, scanned: 2, platform: "x" });
    });

    // Assert SQL state
    await runInDurableObject<SMM, void>(stub, async (_inst, state) => {
      const rows = state.storage.sql
        .exec("SELECT id, external_id, judge_score, status FROM threads_inbox")
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        external_id: "ext-1", judge_score: 0.8, status: "pending",
      });
    });
  });

  it("returns error envelope when platform MCP is unavailable (dry-run error)", async () => {
    const userId = "smm-fx-2";
    const stub = env.SMM.get(env.SMM.idFromName(userId));
    await runInDurableObject<SMM, void>(stub, async (_inst, state) => applySmmSchema(state.storage.sql));

    await runInDurableObject<SMM, void>(stub, async (instance) => {
      const tools = instance.getTools();
      const result = await tools.find_threads_via_xai!.execute!(
        {
          platform: "x",
          maxResults: 5,
          context: "{}",
          _dryRunPlatformError: "X_MCP not yet deployed",
        },
        { experimental_context: { env: instance.bindings, userId } } as never,
      );
      expect(result).toMatchObject({
        queued: 0, scanned: 0, error: expect.stringContaining("X_MCP"),
      });
    });
  });

  it("smoke: getTools() registers find_threads_via_xai", async () => {
    const userId = "smm-fx-3";
    const stub = env.SMM.get(env.SMM.idFromName(userId));
    await runInDurableObject<SMM, void>(stub, async (instance) => {
      const tools = instance.getTools();
      expect(Object.keys(tools).sort()).toEqual(
        ["consult", "draft_for_channel", "find_threads_via_xai", "find_threads", "research_reddit_channels", "process_replies_batch", "process_posts_batch"].sort(),
      );
    });
  });
});
