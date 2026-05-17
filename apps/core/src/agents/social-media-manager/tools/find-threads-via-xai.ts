import { z } from "zod";
import { tool } from "ai";
import { runSkill } from "@shipflare/skills";
import type { SMM } from "../SocialMediaMgr";
import type { Env } from "../../../index";

interface Judgement {
	keep: boolean;
	score: number;
	reason: string;
}

/**
 * find_threads_via_xai — dual-platform thread discovery + judging pipeline.
 *
 * Restored in 5.1c.3 under the AIChatAgent surface. Differences from
 * the pre-Phase-4 version:
 *   - Founder context arrives in the `context` input (inlined by CMO via
 *     consult); peers don't make upward MCP calls.
 *   - Platform search invoked via Service Binding /internal/x_search or
 *     /internal/reddit_search (added in 5.1c.M1).
 *   - Persists to SMM's own SQLite threads_inbox (5.1c.1).
 *
 * Dry-run inputs (`_dryRun*`) short-circuit external dependencies for
 * vitest-pool-workers tests; per the resume note vi.mock() doesn't
 * propagate into the worker bundle so the dry-run path is the test seam.
 */
export function makeFindThreadsViaXaiTool(agent: SMM) {
	return tool({
		description:
			"Discover engagement-worthy threads on a platform (X or Reddit). " +
			"Each candidate is LLM-judged for product fit + engagement value. " +
			"Qualifying threads land in your threads_inbox.",
		inputSchema: z.object({
			platform: z.enum(["x", "reddit"]),
			intent: z.string().optional(),
			maxResults: z.number().int().min(1).max(50).default(20),
			context: z.string().describe(
				"Founder context JSON: { productName, productDescription, voice, audience }. " +
					"Inlined by CMO via consult; peers do not call CMO upward.",
			),
			// Test seams (per resume-note constraint — vi.mock doesn't propagate
			// into the worker bundle, so we expose dry-run inputs for unit tests):
			_dryRunThreads: z
				.array(
					z.object({
						externalId: z.string(),
						author: z.string().optional(),
						content: z.string(),
					}),
				)
				.optional(),
			_dryRunJudgements: z
				.array(
					z.object({
						keep: z.boolean(),
						score: z.number(),
						reason: z.string(),
					}),
				)
				.optional(),
			_dryRunPlatformError: z.string().optional(),
		}),
		execute: async (args) => {
			const userId = agent.name;
			const env = agent.getEnv();
			const sql = agent.getSql();
			const ctxParsed = parseContext(args.context);
			const product = ctxParsed.productName ?? "(product not set)";
			const productDescription = ctxParsed.productDescription ?? "";

			// Step 1: fetch raw threads from the platform MCP (or dry-run input)
			let rawThreads: Array<{ externalId: string; author?: string; content: string }> =
				args._dryRunThreads ?? [];
			let platformError: string | undefined = args._dryRunPlatformError;
			if (!args._dryRunThreads && !args._dryRunPlatformError) {
				const binding = args.platform === "x" ? env.X_MCP : env.REDDIT_MCP;
				const route =
					args.platform === "x" ? "/internal/x_search" : "/internal/reddit_search";
				try {
					const stub = binding.get(binding.idFromName(userId));
					const res = await stub.fetch(
						new Request(`https://internal${route}`, {
							method: "POST",
							headers: {
								"x-shipflare-internal": "1",
								"content-type": "application/json",
							},
							body: JSON.stringify({
								product,
								productDescription,
								intent: args.intent ?? "engagement",
								maxResults: args.maxResults,
							}),
						}),
					);
					if (!res.ok) {
						platformError = `${args.platform.toUpperCase()}_MCP returned ${res.status}`;
					} else {
						rawThreads = (await res.json()) as typeof rawThreads;
					}
				} catch (err) {
					platformError = `${args.platform.toUpperCase()}_MCP fetch failed: ${String(err)}`;
				}
			}
			if (platformError) {
				return {
					queued: 0,
					scanned: 0,
					platform: args.platform,
					error: platformError,
				};
			}

			// Step 2: judge threads (skill call or dry-run)
			let judgements: Judgement[] | undefined = args._dryRunJudgements;
			if (!judgements && rawThreads.length > 0) {
				try {
					const raw = await runSkill<unknown>({
						name: "judging-thread",
						args: {
							product,
							productDescription: productDescription || "(not provided)",
							threads: JSON.stringify(rawThreads, null, 2),
						},
						env: env as Env & { ANTHROPIC_API_KEY: string },
						userId,
					});
					if (Array.isArray(raw)) {
						judgements = raw as Judgement[];
					} else {
						judgements = rawThreads.map(() => ({
							keep: false,
							score: 0,
							reason: "judge unavailable",
						}));
					}
				} catch (err) {
					console.warn(`[SMM ${userId}] judging-thread skill failed:`, err);
					judgements = rawThreads.map(() => ({
						keep: false,
						score: 0,
						reason: "judge errored",
					}));
				}
			}
			const finalJudgements: Judgement[] = judgements ?? [];

			// Step 3: persist qualifying rows to threads_inbox
			const now = Date.now();
			let queued = 0;
			for (let i = 0; i < rawThreads.length; i++) {
				const t = rawThreads[i];
				const j = finalJudgements[i];
				if (!t || !j || !j.keep) continue;
				sql.exec(
					`INSERT INTO threads_inbox
						(id, external_id, platform, author, content, intent, judge_score, judge_reason, judged_at, discovered_at, status)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
					crypto.randomUUID(),
					t.externalId,
					args.platform,
					t.author ?? null,
					t.content,
					args.intent ?? "engagement",
					j.score,
					j.reason,
					now,
					now,
				);
				queued++;
			}

			return { queued, scanned: rawThreads.length, platform: args.platform };
		},
	});
}

function parseContext(s: string): {
	productName?: string;
	productDescription?: string;
	voice?: string;
	audience?: string;
} {
	try {
		const parsed = JSON.parse(s);
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}
