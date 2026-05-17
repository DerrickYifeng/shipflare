import { z } from "zod";
import { tool } from "ai";
import type { SMM } from "../SocialMediaMgr";

/**
 * find_threads — read SMM's threads_inbox cache.
 *
 * Read-only companion to find_threads_via_xai (5.1c.3). Use this when
 * the founder asks "what's queued?" or when the CMO LLM needs to know
 * which threads are pending drafting without re-running discovery.
 *
 * Per spec §2.1: filters by platform CSV + status; ORDER BY judged_at DESC.
 */
export function makeFindThreadsTool(agent: SMM) {
	return tool({
		description:
			"List threads from your threads_inbox. Read-only companion to find_threads_via_xai. " +
			"Returns threads ordered by judged_at DESC, filtered by platform(s) and status.",
		inputSchema: z.object({
			platforms: z.array(z.enum(["x", "reddit"])).min(1).optional(),
			status: z.enum(["pending", "drafted", "skipped"]).default("pending"),
			limit: z.number().int().min(1).max(100).default(20),
		}),
		execute: async (args) => {
			const platforms = args.platforms ?? ["x", "reddit"];
			const placeholders = platforms.map(() => "?").join(",");
			const rows = agent.sqlStorage
				.exec<{
					id: string;
					external_id: string;
					platform: string;
					author: string | null;
					content: string;
					judge_score: number | null;
					judged_at: number | null;
					[k: string]: SqlStorageValue;
				}>(
					`SELECT id, external_id, platform, author, content, judge_score, judged_at
					 FROM threads_inbox
					 WHERE status = ? AND platform IN (${placeholders})
					 ORDER BY judged_at DESC
					 LIMIT ?`,
					args.status,
					...platforms,
					args.limit,
				)
				.toArray();
			return {
				threads: rows.map((r) => ({
					id: r.id,
					externalId: r.external_id,
					platform: r.platform,
					author: r.author,
					content: r.content,
					judgeScore: r.judge_score,
					judgedAt: r.judged_at,
				})),
			};
		},
	});
}
