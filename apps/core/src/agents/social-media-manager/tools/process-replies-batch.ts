import { z } from "zod";
import { tool } from "ai";
import { runSkill } from "@shipflare/skills";
import { validateDraft } from "../lib/validators";
import { mirrorDraft } from "../../../lib/mirror-draft";
import type { SMM } from "../SocialMediaMgr";
import type { Env } from "../../../index";

interface DraftSummary {
	draftId: string;
	threadId: string;
	status: "ready" | "failed";
	validationErrors?: string[];
}

/**
 * process_replies_batch — draft replies for a batch of `threads_inbox` rows.
 *
 * Per spec §2.1, per thread:
 *   1. Read row from `threads_inbox`.
 *   2. `runSkill('drafting-reply')` to draft a reply in the founder's voice.
 *   3. `validateDraft(body, platform)` — platform-leak + length sanity.
 *   4. INSERT into `drafts` (status='ready' if valid, 'failed' otherwise).
 *   5. If ready: POST `/internal/mirror-draft` to CMO. On non-2xx, record
 *      `drafts.mirror_error = httpStatus` and leave `status='ready'`. On
 *      success, promote `status='mirrored'` (matches the schema CHECK
 *      added in 5.1c.1).
 *   6. UPDATE `threads_inbox.status='drafted'` regardless of validation —
 *      the thread has been processed; the 'failed' draft row carries the
 *      validation errors for retry / founder review.
 *
 * Dry-run seam: `_dryRunDrafts: [{ threadId, text }]` bypasses the
 * `drafting-reply` skill call so unit tests don't need an Anthropic key
 * (vi.mock doesn't propagate into the worker bundle — see find-threads-via-xai
 * for the same pattern).
 */
export function makeProcessRepliesBatchTool(agent: SMM) {
	return tool({
		description:
			"Draft replies for an array of thread ids from your threads_inbox. " +
			"Each draft is validated then mirrored to CMO's approval queue.",
		inputSchema: z.object({
			threadIds: z.array(z.string().min(1)).min(1).max(10),
			context: z.string().describe(
				"Founder context JSON: { productName, voice, audience, productDescription }. " +
					"Inlined by CMO via consult; peers do not call CMO upward.",
			),
			_dryRunDrafts: z
				.array(z.object({ threadId: z.string(), text: z.string() }))
				.optional(),
		}),
		execute: async (args) => {
			const userId = agent.name;
			const env = agent.bindings;
			const sql = agent.sqlStorage;
			const ctxParsed = parseContext(args.context);

			const drafts: DraftSummary[] = [];
			let drafted = 0;
			let failed = 0;

			for (const threadId of args.threadIds) {
				const row = sql
					.exec<{
						external_id: string;
						platform: string;
						content: string;
						[k: string]: SqlStorageValue;
					}>(
						"SELECT external_id, platform, content FROM threads_inbox WHERE id = ?",
						threadId,
					)
					.toArray()[0];
				if (!row) {
					drafts.push({
						draftId: "",
						threadId,
						status: "failed",
						validationErrors: ["thread not found"],
					});
					failed++;
					continue;
				}

				// Step 2: draft text (skill or dry-run).
				let text: string;
				const dry = args._dryRunDrafts?.find((d) => d.threadId === threadId);
				if (dry) {
					text = dry.text;
				} else {
					try {
						const raw = await runSkill<unknown>({
							name: "drafting-reply",
							args: {
								product: ctxParsed.productName ?? "(product not set)",
								voice: ctxParsed.voice ?? "(no voice set)",
								thread: row.content,
								platform: row.platform,
							},
							env: env as Env & { ANTHROPIC_API_KEY: string },
							userId,
						});
						text =
							typeof raw === "string"
								? raw
								: (raw as { body?: string })?.body ?? "";
					} catch (err) {
						console.warn(
							`[SMM ${userId}] drafting-reply skill failed for ${threadId}:`,
							err,
						);
						text = "";
					}
				}

				// Step 3: validate. `validateDraft(body, platform)` returns
				// `{ ok, reasons }` — platform-leak + length sanity.
				const platform = row.platform === "reddit" ? "reddit" : "x";
				const validation = validateDraft(text, platform);

				// Step 4: insert drafts row.
				const draftId = crypto.randomUUID();
				const now = Date.now();
				sql.exec(
					`INSERT INTO drafts
						(id, kind, channel, thread_id, body, status, validation_errors, created_at, updated_at)
					 VALUES (?, 'reply', ?, ?, ?, ?, ?, ?, ?)`,
					draftId,
					platform,
					threadId,
					text,
					validation.ok ? "ready" : "failed",
					validation.ok ? null : JSON.stringify(validation.reasons),
					now,
					now,
				);

				// Step 5: mirror to CMO if valid.
				if (validation.ok) {
					try {
						await mirrorDraft(env.CMO, userId, {
							draftId,
							employee: "smm",
							kind: "reply",
							channel: platform,
							preview: text.slice(0, 140),
							createdAt: now,
						});
						sql.exec(
							"UPDATE drafts SET mirrored_at = ?, status = 'mirrored', updated_at = ? WHERE id = ?",
							now,
							now,
							draftId,
						);
					} catch (err) {
						const status = (err as { status?: number }).status ?? 500;
						sql.exec(
							"UPDATE drafts SET mirror_error = ?, updated_at = ? WHERE id = ?",
							status,
							Date.now(),
							draftId,
						);
					}
					drafted++;
					drafts.push({ draftId, threadId, status: "ready" });
				} else {
					failed++;
					drafts.push({
						draftId,
						threadId,
						status: "failed",
						validationErrors: validation.reasons,
					});
				}

				// Step 6: mark thread processed regardless of validation outcome.
				sql.exec(
					"UPDATE threads_inbox SET status = 'drafted' WHERE id = ?",
					threadId,
				);
			}

			return { drafted, failed, drafts };
		},
	});
}

function parseContext(s: string): {
	productName?: string;
	voice?: string;
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
