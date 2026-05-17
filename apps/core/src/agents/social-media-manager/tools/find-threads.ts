import { z } from "zod";
import { tool } from "ai";
import type { SMM } from "../SocialMediaMgr";
import type { ThreadInboxRow } from "../schema";

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
			platforms: z.array(z.enum(["x", "reddit"])).optional(),
			status: z.enum(["pending", "drafted", "skipped"]).optional(),
			limit: z.number().int().min(1).max(100).optional(),
		}),
		execute: async (args) => {
			const platforms = args.platforms ?? ["x", "reddit"];
			const status = args.status ?? "pending";
			const limit = args.limit ?? 20;
			const placeholders = platforms.map(() => "?").join(",");
			const rows = agent.sqlStorage
				.exec<ThreadInboxRow>(
					`SELECT id, external_id, platform, author, content, intent,
					        judge_score, judge_reason, judged_at, discovered_at, status
					 FROM threads_inbox
					 WHERE status = ? AND platform IN (${placeholders})
					 ORDER BY judged_at DESC
					 LIMIT ?`,
					status,
					...platforms,
					limit,
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
