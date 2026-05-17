import { z } from "zod";
import { tool } from "ai";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { postStrategicPathProposal } from "../../../lib/strategic-path-proposal";
import type { HoG } from "../HeadOfGrowth";
import type { Env } from "../../../index";

/**
 * generate_strategic_path — propose a marketing strategy.
 *
 * Per spec §2.2 of the 5.1c design: produces a versioned proposal in HoG's
 * own `proposal_drafts`, appends turns to `planning_chat`, and mirrors to
 * CMO's `strategic_path` with `status='proposed'` via
 * `/internal/strategic-path-proposal` (helper in 5.1c.11). CMO's LLM later
 * approves via its own `commitStrategicPath` tool.
 *
 * Dry-run seam: `_dryRunNarrative: { theme, narrative }` bypasses the
 * Anthropic call so unit tests don't need an API key — matches the pattern
 * used by SMM tools (5.1c.3) since vi.mock() doesn't propagate into the
 * worker bundle.
 */
export function makeGenerateStrategicPathTool(agent: HoG) {
	return tool({
		description:
			"Propose a marketing strategy. Persists to your proposal_drafts " +
			"and mirrors to CMO's strategic_path with status='proposed'.",
		inputSchema: z.object({
			context: z.string().describe(
				"Founder context JSON: { productName, audience, productDescription, voice }.",
			),
			goal: z.string().optional(),
			_dryRunNarrative: z
				.object({
					theme: z.string(),
					narrative: z.unknown(),
				})
				.optional(),
		}),
		execute: async (args) => {
			const userId = agent.name;
			const env = agent.bindings as Env;
			const now = Date.now();

			// 1. Determine next version (MAX + 1)
			const versionRow = agent.sqlStorage
				.exec<{ v: number | null; [k: string]: SqlStorageValue }>(
					"SELECT MAX(version) AS v FROM proposal_drafts",
				)
				.toArray()[0];
			const lastVersion = versionRow?.v ?? 0;
			const version = lastVersion + 1;

			// 2. Persist user turn
			agent.sqlStorage.exec(
				"INSERT INTO planning_chat (role, content, ts) VALUES (?, ?, ?)",
				"user",
				args.goal ?? "Propose a strategic path",
				now,
			);

			// 3. Generate (or dry-run)
			let theme: string;
			let narrative: unknown;
			if (args._dryRunNarrative) {
				theme = args._dryRunNarrative.theme;
				narrative = args._dryRunNarrative.narrative;
			} else {
				try {
					const out = await generateText({
						model: anthropic("claude-sonnet-4-6"),
						system:
							"You are a marketing strategist. Reply with ONLY valid JSON of the shape: " +
							`{ "theme": "...", "narrative": { "wedge": "...", "channels": [...], "tactics": [...], "kpis": [...] } }`,
						prompt:
							`Context: ${args.context}\n` +
							(args.goal ? `Goal: ${args.goal}\n` : "") +
							`Output the strategic path JSON now.`,
					});
					const parsed = JSON.parse(out.text);
					theme = parsed.theme;
					narrative = parsed.narrative;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(
						`[HoG ${userId}] generate_strategic_path Anthropic call failed:`,
						msg,
					);
					return {
						proposalId: "",
						version,
						theme: "",
						narrative: null,
						mirrored: false,
						error: `Anthropic generation failed: ${msg}`,
					};
				}
			}

			// 4. Persist proposal_drafts row
			const proposalId = crypto.randomUUID();
			agent.sqlStorage.exec(
				`INSERT INTO proposal_drafts (id, version, theme, narrative_json, generated_at)
				 VALUES (?, ?, ?, ?, ?)`,
				proposalId,
				version,
				theme,
				JSON.stringify(narrative),
				now,
			);

			// 5. Persist assistant turn
			agent.sqlStorage.exec(
				"INSERT INTO planning_chat (role, content, ts) VALUES (?, ?, ?)",
				"assistant",
				`Proposed strategic path v${version}: ${theme}`,
				now,
			);

			// 6. Mirror to CMO
			let mirrored = false;
			let mirrorError: number | undefined;
			try {
				await postStrategicPathProposal(env.CMO, userId, {
					version,
					theme,
					narrativeJson: JSON.stringify(narrative),
					generatedAt: now,
					generatedBy: "hog",
				});
				agent.sqlStorage.exec(
					"UPDATE proposal_drafts SET mirrored_to_cmo = 1 WHERE id = ?",
					proposalId,
				);
				mirrored = true;
			} catch (err) {
				mirrorError = (err as { status?: number }).status ?? 500;
				agent.sqlStorage.exec(
					"UPDATE proposal_drafts SET mirror_error = ? WHERE id = ?",
					mirrorError,
					proposalId,
				);
				console.warn(
					`[HoG ${userId}] mirror to CMO failed for proposal v${version}:`,
					mirrorError,
				);
			}

			return { proposalId, version, theme, narrative, mirrored };
		},
	});
}
