import { z } from "zod";
import type { CMO } from "../agents/cmo/CMO";
import { transportName } from "./do-name";

/**
 * Zod schema for the body POSTed to CMO `/internal/strategic-path-proposal`.
 *
 * HoG's `generate_strategic_path` peer tool (5.1c.8) writes a proposal
 * row in its own SQLite, then shadow-POSTs here so CMO's strategic_path
 * table gets a `status='proposed'` row that the CMO LLM can later
 * commit via `commitStrategicPath`.
 *
 * Idempotent on `(version, generated_by)` — multi-deliveries of the same
 * proposal are no-ops.
 */
export const strategicPathProposalBodySchema = z.object({
	version: z.number().int().positive(),
	theme: z.string().min(1),
	narrativeJson: z.string(),
	generatedAt: z.number().int().nonnegative(),
	generatedBy: z.enum(["hog"]),   // future: add 'cmo' or others if needed
});

export type StrategicPathProposalPayload = z.infer<typeof strategicPathProposalBodySchema>;

/**
 * POST to CMO's /internal/strategic-path-proposal via Service Binding.
 *
 * Uses the same `transportName(userId)` helper as `logPeerDmShadow` and
 * `mirrorDraft` so the transport prefix has a single source of truth.
 *
 * Throws Error with `status` property on non-2xx so callers can record
 * `proposal_drafts.mirror_error` (HoG-side).
 */
export async function postStrategicPathProposal(
	cmoBinding: DurableObjectNamespace<CMO>,
	userId: string,
	payload: StrategicPathProposalPayload,
): Promise<void> {
	const cmoId = cmoBinding.idFromName(transportName(userId));
	const cmoStub = cmoBinding.get(cmoId);
	const res = await cmoStub.fetch(
		new Request("https://internal/internal/strategic-path-proposal", {
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
			`postStrategicPathProposal failed: ${res.status} ${await res.text().catch(() => "(no body)")}`,
		);
		err.status = res.status;
		throw err;
	}
}
