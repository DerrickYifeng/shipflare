import { z } from "zod";
import { tool } from "ai";
import type { SMM } from "../SocialMediaMgr";
import type { Env } from "../../../index";

/**
 * research_reddit_channels — discover top subreddits for the founder's ICP.
 *
 * Calls REDDIT_MCP `/internal/research_subreddits` (added in 5.1c.M1).
 * Returns ranked candidates + a `topThree` convenience array — the CMO LLM
 * decides whether to commit the result to founder_context.subreddits via
 * its own setFounderContext tool (spec §1.2 invariant: peers don't write
 * CMO state).
 *
 * Dry-run seam (`_dryRunCandidates`, `_dryRunMcpError`) bypasses Service
 * Binding for vitest tests.
 */
export function makeResearchRedditChannelsTool(agent: SMM) {
	return tool({
		description:
			"Discover the top subreddits for the founder's audience. " +
			"Returns ranked candidates with a topThree convenience array — " +
			"the caller decides whether to commit them as founder_context.subreddits.",
		inputSchema: z.object({
			context: z.string().describe(
				"Founder context JSON: { productName, audience, productDescription }. " +
					"Inlined by CMO via consult; peers do not call CMO upward.",
			),
			_dryRunCandidates: z
				.array(
					z.object({
						subreddit: z.string(),
						rank: z.number(),
						fitScore: z.number(),
					}),
				)
				.optional(),
			_dryRunMcpError: z.string().optional(),
		}),
		execute: async (args) => {
			const userId = agent.name;
			const env = agent.bindings as Env;
			const ctxParsed = parseContext(args.context);
			const product = ctxParsed.productName ?? "";
			const audience = ctxParsed.audience;

			// Dry-run short-circuit
			if (args._dryRunMcpError) {
				return {
					subreddits: [],
					topThree: [],
					error: `REDDIT_MCP unavailable: ${args._dryRunMcpError}`,
				};
			}

			let candidates = args._dryRunCandidates;
			if (!candidates) {
				if (!product) {
					return {
						subreddits: [],
						topThree: [],
						error: "context.productName missing — cannot research subreddits",
					};
				}
				try {
					const stub = env.REDDIT_MCP.get(env.REDDIT_MCP.idFromName(userId));
					const res = await stub.fetch(
						new Request("https://internal/internal/research_subreddits", {
							method: "POST",
							headers: {
								"x-shipflare-internal": "1",
								"content-type": "application/json",
							},
							body: JSON.stringify({ product, audience }),
						}),
					);
					if (!res.ok) {
						return {
							subreddits: [],
							topThree: [],
							error: `REDDIT_MCP returned ${res.status}`,
						};
					}
					candidates = (await res.json()) as typeof candidates;
				} catch (err) {
					return {
						subreddits: [],
						topThree: [],
						error: `REDDIT_MCP fetch failed: ${String(err)}`,
					};
				}
			}
			candidates = candidates ?? [];

			// Top-3 convenience array (already sorted by fitScore desc by the MCP impl)
			const topThree = candidates.slice(0, 3).map((c) => c.subreddit);
			return {
				subreddits: candidates,
				topThree,
			};
		},
	});
}

function parseContext(s: string): {
	productName?: string;
	audience?: string;
	productDescription?: string;
} {
	try {
		const parsed = JSON.parse(s);
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}
