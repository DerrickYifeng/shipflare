import { z } from "zod";
import type { CMO } from "../agents/cmo/CMO";
import { transportName } from "./do-name";

/**
 * Zod schema for the body POSTed to CMO `/internal/mirror-draft`.
 *
 * SMM + HoG peer tools that produce a `ready` draft fire-and-forget POST
 * here; CMO's handler inserts a row into `approval_queue`. Idempotent on
 * `draftId` (the SMM/HoG-side UUID).
 */
export const mirrorDraftBodySchema = z.object({
	draftId: z.string().min(1),
	employee: z.enum(["smm", "hog"]),
	kind: z.enum(["reply", "post"]),
	channel: z.enum(["x", "reddit"]),
	preview: z.string(),
	createdAt: z.number().int().nonnegative(),
});

export type MirrorDraftPayload = z.infer<typeof mirrorDraftBodySchema>;

/**
 * POST to CMO's /internal/mirror-draft via Service Binding.
 *
 * Uses the same `transportName(userId)` helper as `logPeerDmShadow` so the
 * transport prefix has a single source of truth.
 *
 * Throws on non-2xx so callers can record `drafts.mirror_error` (the SMM
 * `drafts` table has a `mirror_error INTEGER` column for the last HTTP
 * status of a failed mirror).
 */
export async function mirrorDraft(
	cmoBinding: DurableObjectNamespace<CMO>,
	userId: string,
	payload: MirrorDraftPayload,
): Promise<void> {
	const cmoId = cmoBinding.idFromName(transportName(userId));
	const stub = cmoBinding.get(cmoId);
	const res = await stub.fetch(
		new Request("https://internal/internal/mirror-draft", {
			method: "POST",
			headers: {
				"x-shipflare-internal": "1",
				"content-type": "application/json",
			},
			body: JSON.stringify(payload),
		}),
	);
	if (!res.ok) {
		const err: Error & { status?: number } = new Error(
			`mirrorDraft POST failed: ${res.status} ${await res.text().catch(() => "(no body)")}`,
		);
		err.status = res.status;
		throw err;
	}
}
