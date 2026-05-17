import { z } from "zod";
import { tool } from "ai";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { HoG } from "../HeadOfGrowth";

const SEVERITY = ["high", "med", "low"] as const;
const CATEGORY = ["gap", "redundancy", "risk"] as const;

const findingShape = z.object({
	severity: z.enum(SEVERITY),
	category: z.enum(CATEGORY),
	finding: z.string().min(1),
	affectedPlanItems: z.array(z.string()).optional(),
});

/**
 * audit_plan — review the current plan_items for gaps, redundancies, risks.
 *
 * Per spec §2.2: HoG generates findings via Anthropic, persists each to its
 * own `audit_findings` table (HoG-private), returns the summary so the CMO
 * LLM can decide whether to addPlanItem for high-severity gaps.
 *
 * No mirror — audit findings stay HoG-private; CMO consumes the consult
 * return value directly.
 *
 * Dry-run seam: `_dryRunFindings: [...]` bypasses the Anthropic call.
 */
export function makeAuditPlanTool(agent: HoG) {
	return tool({
		description:
			"Review the current marketing plan_items for gaps, redundancies, and risks. " +
			"Persists findings to your audit_findings table; returns a summary for the caller.",
		inputSchema: z.object({
			context: z.string().describe(
				"Founder context JSON + plan items snapshot: " +
					"{ productName, audience, productDescription, planItems: [{ id, channel, topic, status }] }.",
			),
			statusFilter: z.enum(["pending", "in_progress", "all"]).default("all"),
			_dryRunFindings: z.array(findingShape).optional(),
		}),
		execute: async (args) => {
			const userId = agent.name;
			const now = Date.now();
			const auditRunId = crypto.randomUUID();

			// 1. Generate findings (or dry-run)
			let findings: z.infer<typeof findingShape>[] = [];
			if (args._dryRunFindings) {
				findings = args._dryRunFindings;
			} else {
				try {
					const out = await generateText({
						model: anthropic("claude-sonnet-4-6"),
						system:
							"You audit marketing plans for gaps, redundancies, and risks. " +
							"Reply with ONLY valid JSON of the shape: " +
							`{ "findings": [{ "severity": "high"|"med"|"low", "category": "gap"|"redundancy"|"risk", ` +
							`"finding": "<short description>", "affectedPlanItems": ["<plan_item_id>", ...] }] }`,
						prompt:
							`Context: ${args.context}\n` +
							`Status filter: ${args.statusFilter}\n` +
							`Audit the plan now. Return findings JSON.`,
					});
					const parsed = JSON.parse(out.text) as { findings?: unknown };
					if (Array.isArray(parsed.findings)) {
						for (const item of parsed.findings) {
							const validated = findingShape.safeParse(item);
							if (validated.success) findings.push(validated.data);
						}
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(`[HoG ${userId}] audit_plan Anthropic call failed:`, msg);
					return {
						auditRunId,
						findingsCount: 0,
						findings: [],
						error: `Anthropic audit generation failed: ${msg}`,
					};
				}
			}

			// 2. Persist each finding to audit_findings
			const persistedFindings: Array<{
				id: string;
				severity: string;
				category: string;
				finding: string;
				affectedPlanItems: string[];
			}> = [];
			for (const f of findings) {
				const findingId = crypto.randomUUID();
				const affected = f.affectedPlanItems ?? [];
				agent.sqlStorage.exec(
					`INSERT INTO audit_findings
						(id, audit_run_id, severity, category, finding, affected_plan_items, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					findingId,
					auditRunId,
					f.severity,
					f.category,
					f.finding,
					affected.length > 0 ? JSON.stringify(affected) : null,
					now,
				);
				persistedFindings.push({
					id: findingId,
					severity: f.severity,
					category: f.category,
					finding: f.finding,
					affectedPlanItems: affected,
				});
			}

			// 3. Return summary
			return {
				auditRunId,
				findingsCount: persistedFindings.length,
				findings: persistedFindings,
			};
		},
	});
}
