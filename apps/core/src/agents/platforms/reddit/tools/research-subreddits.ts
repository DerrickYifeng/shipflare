import { z } from "zod";
import type { RedditMcpAgent } from "../RedditMcpAgent";

/**
 * research_subreddits — find subreddits where the founder's ICP
 * gathers, ranked by a quick subscriber-count heuristic.
 *
 * Anonymous: hits Reddit's public `subreddits/search.json` endpoint;
 * no OAuth needed. Same `User-Agent` discipline as `reddit_search`.
 *
 * Caller: invoked by SMM's `research_reddit_channels` tool (see
 * `apps/core/src/agents/social-media-manager/tools/research-reddit-channels.ts`).
 * SMM takes the top-3 and writes them to CMO's `founder_context`
 * under key `subreddits` so subsequent sweeps can scope to them.
 *
 * Output: `[{ subreddit, rank, fitScore }]` — `rank` is 1-indexed
 * ORIGINAL order from Reddit's relevance ranking (kept so the caller
 * can compare against fitScore), `fitScore` is a normalized
 * subscriber-density proxy in `[0, 1]`. We sort the output by
 * fitScore desc so SMM's top-3 grab is a `.slice(0, 3)`.
 *
 * The fitScore formula is intentionally a heuristic:
 *   fitScore = clamp(log10(subscribers + 1) / 7, 0, 1)
 * which puts 1M+ subscriber subreddits near 1.0 and tiny niche
 * subreddits near 0. Phase 2 follow-up: replace with an LLM-judged
 * fit against productDescription (the input is already plumbed
 * through for this — the helper just doesn't use it yet).
 *
 * Graceful degradation: any non-2xx OR parse failure returns `[]`
 * rather than crashing the caller — same pattern as `reddit_search`.
 * The empty result surfaces as "REDDIT_MCP returned no candidates"
 * upstream and the caller's next tick retries.
 */
export function registerResearchSubredditsTool(agent: RedditMcpAgent): void {
  agent.server.registerTool(
    "research_subreddits",
    {
      description:
        "Discover subreddits where the founder's ICP gathers. Returns " +
        "[{subreddit, rank, fitScore}] sorted by fitScore desc. " +
        "Anonymous: no OAuth required.",
      inputSchema: {
        product: z.string().min(1),
        audience: z.string().optional(),
        productDescription: z
          .string()
          .optional()
          .describe(
            "Reserved for Phase 2 LLM-fit scoring. Currently unused " +
              "by the subscriber-density heuristic.",
          ),
      },
    },
    async ({ product, audience }) => {
      const url = new URL("https://www.reddit.com/subreddits/search.json");
      url.searchParams.set("q", `${product} ${audience ?? ""}`.trim());
      url.searchParams.set("limit", "10");

      let res: Response;
      try {
        res = await fetch(url.toString(), {
          headers: {
            "User-Agent": "shipflare-cf/1.0 (https://shipflare.com)",
          },
        });
      } catch (err) {
        console.error("[research_subreddits] fetch failed:", err);
        return jsonContent([]);
      }

      if (!res.ok) {
        console.error(
          `[research_subreddits] reddit returned ${res.status}: ${await res
            .text()
            .catch(() => "(no body)")}`,
        );
        return jsonContent([]);
      }

      let data: RedditListing<SubredditData>;
      try {
        data = (await res.json()) as RedditListing<SubredditData>;
      } catch (err) {
        console.error(
          "[research_subreddits] response JSON parse failed:",
          err,
        );
        return jsonContent([]);
      }

      const candidates = (data.data?.children ?? [])
        .map((c, idx) => {
          const d = c?.data;
          if (!d || typeof d.display_name !== "string") return null;
          const subscribers =
            typeof d.subscribers === "number" && d.subscribers >= 0
              ? d.subscribers
              : 0;
          // log10(N+1)/7: 1 subscriber ≈ 0.04, 1k ≈ 0.43, 1M ≈ 0.86,
          // 10M ≈ 1.0. Clamped at 1 to keep the range stable for
          // downstream UI / ordering.
          const fitScore = Math.min(
            1,
            Math.log10(subscribers + 1) / 7,
          );
          return {
            subreddit: `r/${d.display_name}`,
            rank: idx + 1,
            fitScore,
          };
        })
        .filter(
          (c): c is { subreddit: string; rank: number; fitScore: number } =>
            c !== null,
        )
        .sort((a, b) => b.fitScore - a.fitScore);

      return jsonContent(candidates);
    },
  );
}

interface RedditListing<TData> {
  data?: {
    children?: Array<{
      data?: TData;
    }>;
  };
}

interface SubredditData {
  display_name: string;
  subscribers?: number;
  public_description?: string;
}

function jsonContent(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}
