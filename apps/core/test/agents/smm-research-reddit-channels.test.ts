import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SMM } from "../../src/agents/social-media-manager/SocialMediaMgr";

describe("SMM tool research_reddit_channels", () => {
  it("returns ranked candidates with topThree from dry-run input", async () => {
    const userId = "smm-rrc-1";
    const stub = env.SMM.get(env.SMM.idFromName(userId));
    await runInDurableObject<SMM, void>(stub, async (instance) => {
      const tool = instance.getTools().research_reddit_channels!;
      const parsed = (tool.inputSchema as z.ZodTypeAny).parse({
        context: JSON.stringify({ productName: "TestProd", audience: "developers" }),
        _dryRunCandidates: [
          { subreddit: "r/programming", rank: 1, fitScore: 0.9 },
          { subreddit: "r/webdev",       rank: 2, fitScore: 0.7 },
          { subreddit: "r/saas",         rank: 3, fitScore: 0.6 },
          { subreddit: "r/random",       rank: 4, fitScore: 0.2 },
        ],
      });
      const r = await tool.execute!(parsed, {
        experimental_context: { env: instance.bindings, userId },
      } as never);
      const result = r as { subreddits: unknown[]; topThree: string[] };
      expect(result.subreddits).toHaveLength(4);
      expect(result.topThree).toEqual(["r/programming", "r/webdev", "r/saas"]);
    });
  });

  it("returns error envelope when REDDIT_MCP fetch fails (dry-run error)", async () => {
    const userId = "smm-rrc-2";
    const stub = env.SMM.get(env.SMM.idFromName(userId));
    await runInDurableObject<SMM, void>(stub, async (instance) => {
      const tool = instance.getTools().research_reddit_channels!;
      const parsed = (tool.inputSchema as z.ZodTypeAny).parse({
        context: "{}",
        _dryRunMcpError: "REDDIT_MCP not yet deployed",
      });
      const r = await tool.execute!(parsed, {
        experimental_context: { env: instance.bindings, userId },
      } as never);
      const result = r as { subreddits: unknown[]; topThree: string[]; error?: string };
      expect(result.subreddits).toEqual([]);
      expect(result.topThree).toEqual([]);
      expect(result.error).toContain("REDDIT_MCP");
    });
  });

  it("smoke: getTools() registers research_reddit_channels", async () => {
    const userId = "smm-rrc-3";
    const stub = env.SMM.get(env.SMM.idFromName(userId));
    await runInDurableObject<SMM, void>(stub, async (instance) => {
      const tools = instance.getTools();
      expect(Object.keys(tools)).toContain("research_reddit_channels");
    });
  });
});
