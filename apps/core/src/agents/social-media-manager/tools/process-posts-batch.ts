import { z } from "zod";
import { tool } from "ai";
import { runSkill } from "@shipflare/skills";
import { validateDraft } from "../lib/validators";
import { mirrorDraft } from "../../../lib/mirror-draft";
import type { SMM } from "../SocialMediaMgr";
import type { Env } from "../../../index";

/**
 * process_posts_batch — draft original posts for a batch of plan_item ids.
 *
 * Per spec §2.1: for each plan_item:
 *   1. Look up the plan item details in `context.planItems` (inlined by CMO —
 *      peers don't read CMO SQLite). If missing → status='failed'.
 *   2. runSkill('drafting-post') to draft. Reddit posts return {title, body};
 *      X posts return just body.
 *   3. Validate via validateDraft(body, platform). For Reddit, combine title+body.
 *   4. Persist to drafts (kind='post', plan_item_id link).
 *   5. If ready: mirror to CMO; promote drafts.status='mirrored' on success.
 *
 * Dry-run seam: `_dryRunDrafts: [{ planItemId, title?, body }]`.
 *
 * CMO LLM (NOT this tool) handles updatePlanItem after consult return —
 * spec §1.2 invariant: peers don't write CMO state.
 */
export function makeProcessPostsBatchTool(agent: SMM) {
	return tool({
		description:
			"Draft original posts for an array of plan_item ids. " +
			"Plan item details must be provided in context.planItems. " +
			"Each draft is validated then mirrored to CMO's approval queue.",
		inputSchema: z.object({
			planItemIds: z.array(z.string().min(1)).min(1).max(10),
			context: z.string().describe(
				"Founder context JSON + plan items: { productName, voice?, audience?, " +
					"productDescription?, planItems: [{ id, channel, topic, paramsJson }] }.",
			),
			_dryRunDrafts: z.array(z.object({
				planItemId: z.string(),
				title: z.string().optional(),
				body: z.string(),
			})).optional(),
		}),
		execute: async (args) => {
			const userId = agent.name;
			const env = agent.bindings as Env;
			const ctxParsed = parseContext(args.context);

			const drafts: Array<{
				draftId: string;
				planItemId: string;
				status: "ready" | "failed";
				validationErrors?: string[];
			}> = [];
			let drafted = 0;
			let failed = 0;

			for (const planItemId of args.planItemIds) {
				const planItem = ctxParsed.planItems?.find((p) => p.id === planItemId);
				if (!planItem) {
					drafts.push({
						draftId: "",
						planItemId,
						status: "failed",
						validationErrors: ["plan item not found in context"],
					});
					failed++;
					continue;
				}

				const channel = planItem.channel;
				let title: string | undefined;
				let body: string;
				const dry = args._dryRunDrafts?.find((d) => d.planItemId === planItemId);
				if (dry) {
					title = dry.title;
					body = dry.body;
				} else {
					try {
						const raw = await runSkill<unknown>({
							name: "drafting-post",
							args: {
								product: ctxParsed.productName ?? "(product not set)",
								voice: ctxParsed.voice ?? "(no voice set)",
								topic: planItem.topic,
								channel,
								paramsJson: planItem.paramsJson ?? "{}",
							},
							env: env as Env & { ANTHROPIC_API_KEY: string },
							userId,
						});
						if (channel === "reddit" && typeof raw === "object" && raw !== null) {
							const r = raw as { title?: string; body?: string };
							title = r.title;
							body = r.body ?? "";
						} else {
							body = typeof raw === "string" ? raw : (raw as { text?: string })?.text ?? "";
						}
					} catch (err) {
						console.warn(`[SMM ${userId}] drafting-post skill failed for ${planItemId}:`, err);
						body = "";
					}
				}

				// Validate. For Reddit, validate title+body combined (length includes title).
				const validateBody = channel === "reddit" && title ? `${title}\n\n${body}` : body;
				const validation = validateDraft(validateBody, channel);

				const draftId = crypto.randomUUID();
				const now = Date.now();
				agent.sqlStorage.exec(
					`INSERT INTO drafts (id, kind, channel, plan_item_id, body, body_title, status, validation_errors, created_at, updated_at)
					 VALUES (?, 'post', ?, ?, ?, ?, ?, ?, ?, ?)`,
					draftId,
					channel,
					planItemId,
					body,
					title ?? null,
					validation.ok ? "ready" : "failed",
					validation.ok ? null : JSON.stringify(validation.reasons),
					now,
					now,
				);

				if (validation.ok) {
					try {
						const previewParts: string[] = [];
						if (title) previewParts.push(title);
						previewParts.push(body);
						await mirrorDraft(env.CMO, userId, {
							draftId,
							employee: "smm",
							kind: "post",
							channel,
							preview: previewParts.join(" — ").slice(0, 140),
							createdAt: now,
						});
						agent.sqlStorage.exec(
							"UPDATE drafts SET mirrored_at = ?, status = 'mirrored', updated_at = ? WHERE id = ?",
							now, now, draftId,
						);
					} catch (err) {
						const status = (err as { status?: number }).status ?? 500;
						agent.sqlStorage.exec(
							"UPDATE drafts SET mirror_error = ?, updated_at = ? WHERE id = ?",
							status, Date.now(), draftId,
						);
					}
					drafted++;
					drafts.push({ draftId, planItemId, status: "ready" });
				} else {
					failed++;
					drafts.push({ draftId, planItemId, status: "failed", validationErrors: validation.reasons });
				}
			}

			return { drafted, failed, drafts };
		},
	});
}

interface PlanItem {
	id: string;
	channel: "x" | "reddit";
	topic: string;
	paramsJson?: string;
}

function parseContext(s: string): {
	productName?: string;
	voice?: string;
	audience?: string;
	productDescription?: string;
	planItems?: PlanItem[];
} {
	try {
		const parsed = JSON.parse(s);
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}
