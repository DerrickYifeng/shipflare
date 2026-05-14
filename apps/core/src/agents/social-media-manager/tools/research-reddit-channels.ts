import { z } from "zod";
import { mcpServerName, platformServerName } from "@shipflare/shared";
import { extractText } from "../lib/mcp-result";
import type { SocialMediaMgr } from "../SocialMediaMgr";

interface Subreddit {
  subreddit: string;
  rank: number;
  fitScore: number;
}

/**
 * research_reddit_channels — discover top-3 subreddits for the founder's ICP.
 *
 * Called by CMO via delegateToEmployee. Typical triggers:
 *   - Reddit channel freshly connected, no subreddits researched yet
 *   - Founder says "find new subreddits for us"
 *   - Periodic refresh
 *
 * Flow:
 *   1. Pull founder_context for productName, audience, productDescription
 *   2. RPC REDDIT_MCP.research_subreddits for ranked candidates
 *   3. Top-3 written to CMO.setFounderContext('subreddits', JSON)
 *   4. Return { subreddits, written }
 *
 * Per spec §6.1: SMM never writes CMO's founder_context directly. Writes
 * go through CMO.setFounderContext RPC.
 *
 * Forward-compat: REDDIT_MCP lands in S5. Until then, gracefully returns
 * a "not yet deployed" error.
 */
export function registerResearchRedditChannelsTool(
  agent: SocialMediaMgr,
): void {
  agent.server.registerTool(
    "research_reddit_channels",
    {
      description:
        "Discover top-3 subreddits where the founder's ICP gathers. Calls " +
        "REDDIT_MCP for ranked candidates, writes the top-3 to CMO's " +
        "founder_context (key='subreddits'). Returns { subreddits, written }.",
      inputSchema: {
        force: z
          .boolean()
          .default(false)
          .describe(
            "If true, re-run discovery even if subreddits are already in " +
              "founder_context. Default false: skip if already researched.",
          ),
      },
    },
    async ({ force }) => {
      const userId = agent.props?.userId;
      if (!userId) throw new Error("SMM has no userId");

      const cmoServerName = mcpServerName("cmo", userId);
      const cmo = agent.mcp
        .listServers()
        .find((s) => s.name === cmoServerName);
      if (!cmo) {
        return errorResult(
          "CMO not connected — cannot read founder_context or write subreddits",
        );
      }

      // Step 1: read founder_context
      let founderContext: Record<string, string> = {};
      try {
        const result = await agent.mcp.callTool({
          serverId: cmo.id,
          name: "queryFounderContext",
          arguments: {},
        });
        founderContext = JSON.parse(extractText(result)) as Record<
          string,
          string
        >;
      } catch (err) {
        return errorResult(`queryFounderContext failed: ${String(err)}`);
      }

      // Step 1b: skip if already researched and !force
      if (!force && founderContext.subreddits) {
        try {
          const existing = JSON.parse(
            founderContext.subreddits,
          ) as Subreddit[];
          if (Array.isArray(existing) && existing.length > 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    subreddits: existing,
                    written: 0,
                    skipped: true,
                    reason: "already researched (pass force=true to re-run)",
                  }),
                },
              ],
            };
          }
        } catch {
          // Corrupted founder_context.subreddits — proceed with fresh research
        }
      }

      const product = founderContext.productName ?? "";
      const audience = founderContext.audience ?? "";
      const productDescription = founderContext.productDescription ?? "";

      if (!product) {
        return errorResult(
          "founder_context.productName not set; cannot research without product name",
        );
      }

      // Step 2: find REDDIT_MCP and call research_subreddits
      const redditServerName = platformServerName("reddit", userId);
      const reddit = agent.mcp
        .listServers()
        .find((s) => s.name === redditServerName);
      if (!reddit) {
        return errorResult(
          "REDDIT_MCP not yet deployed (S5). Try again after S5 lands.",
        );
      }

      let candidates: Subreddit[] = [];
      try {
        const result = await agent.mcp.callTool({
          serverId: reddit.id,
          name: "research_subreddits",
          arguments: {
            product,
            audience,
            productDescription,
          },
        });
        candidates = JSON.parse(extractText(result)) as Subreddit[];
      } catch (err) {
        return errorResult(
          `reddit research_subreddits failed: ${String(err)}`,
        );
      }

      if (!Array.isArray(candidates) || candidates.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                subreddits: [],
                written: 0,
                reason: "REDDIT_MCP returned no candidates",
              }),
            },
          ],
        };
      }

      const top3 = candidates
        .slice()
        .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
        .slice(0, 3);

      // Step 3: write top-3 to CMO.setFounderContext
      try {
        await agent.mcp.callTool({
          serverId: cmo.id,
          name: "setFounderContext",
          arguments: {
            key: "subreddits",
            value: JSON.stringify(top3),
          },
        });
      } catch (err) {
        // Non-fatal: return candidates anyway, founder can retry or set manually
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                subreddits: top3,
                written: 0,
                warning: `setFounderContext failed: ${String(err)}`,
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              subreddits: top3,
              written: top3.length,
            }),
          },
        ],
      };
    },
  );
}

function errorResult(error: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ subreddits: [], written: 0, error }),
      },
    ],
  };
}
