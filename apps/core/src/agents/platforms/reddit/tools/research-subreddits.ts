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
 *
 * --- 5.1c.M1: pure-async helper extracted ---
 * `researchSubredditsImpl` is the canonical research function. Both
 * the MCP tool registration AND the `/internal/research_subreddits`
 * HTTP route on `RedditMcpAgent` call it directly. No env needed
 * (Reddit's public JSON API is anonymous).
 */

export const researchSubredditsArgsSchema = z.object({
	product: z.string().min(1),
	audience: z.string().optional(),
});
export type ResearchSubredditsArgs = z.infer<typeof researchSubredditsArgsSchema>;

export interface SubredditCandidate {
	subreddit: string;
	rank: number;
	fitScore: number;
}

export async function researchSubredditsImpl(
	args: ResearchSubredditsArgs,
): Promise<SubredditCandidate[]> {
	const { product, audience } = args;
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
		return [];
	}

	if (!res.ok) {
		console.error(
			`[research_subreddits] reddit returned ${res.status}: ${await res
				.text()
				.catch(() => "(no body)")}`,
		);
		return [];
	}

	let data: RedditListing<SubredditData>;
	try {
		data = (await res.json()) as RedditListing<SubredditData>;
	} catch (err) {
		console.error(
			"[research_subreddits] response JSON parse failed:",
			err,
		);
		return [];
	}

	return (data.data?.children ?? [])
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
			const fitScore = Math.min(1, Math.log10(subscribers + 1) / 7);
			return {
				subreddit: `r/${d.display_name}`,
				rank: idx + 1,
				fitScore,
			};
		})
		.filter((c): c is SubredditCandidate => c !== null)
		.sort((a, b) => b.fitScore - a.fitScore);
}

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
      },
    },
    async ({ product, audience }) => {
      const candidates = await researchSubredditsImpl({
        product,
        audience,
      });
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
