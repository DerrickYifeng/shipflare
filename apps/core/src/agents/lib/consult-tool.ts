import { z } from "zod";
import { tool } from "ai";
import { agentTool } from "agents/agent-tools";
import {
	EMPLOYEE_IDS,
	EMPLOYEE_REGISTRY,
	type EmployeeId,
} from "../registry";
import { peerInputSchema } from "./peer-schema";
import { safeAgentChain } from "../../lib/agent-depth";

/**
 * Lazy-initialise one `agentTool` per employee on first access. `agents@0.12.4`
 * exposes only `agentTool(Cls, options)` (verified Phase 0); there is no
 * free-function `runAgentTool`. CMO is excluded — it's still McpAgent through
 * Phase 5, and peers don't consult CMO upward anyway (see filter below).
 *
 * Lazy (not top-level) construction is REQUIRED to break the
 *   registry ⇄ HoG/SMM ⇄ consult-tool
 * import cycle. At top level, when `registry.ts` is the cycle entry, the
 * partially-evaluated registry module returns `EMPLOYEE_IDS = undefined` and
 * the iteration crashes with `EMPLOYEE_IDS is not iterable`. By the time
 * any caller invokes `makeConsultTool(...).execute(...)`, all modules have
 * finished evaluating and the lookup is safe.
 */
let PEER_TOOLS: Partial<Record<EmployeeId, ReturnType<typeof agentTool>>> | null =
	null;
function getPeerTools(): Partial<
	Record<EmployeeId, ReturnType<typeof agentTool>>
> {
	if (PEER_TOOLS) return PEER_TOOLS;
	const built: Partial<Record<EmployeeId, ReturnType<typeof agentTool>>> = {};
	for (const id of EMPLOYEE_IDS) {
		if (id === "cmo") continue; // CMO is not ChatCapable until Phase 5
		const meta = EMPLOYEE_REGISTRY[id];
		if (!meta) continue;
		built[id] = agentTool(meta.class, {
			description: meta.description,
			inputSchema: peerInputSchema,
		});
	}
	PEER_TOOLS = built;
	return PEER_TOOLS;
}

/**
 * Build a consult tool scoped to `selfId`. The enum of allowed `employee`
 * values is computed at construction time:
 *   - cannot consult self
 *   - non-CMO callers cannot consult CMO upward (spec §3.2 invariant)
 *   - CMO callers can consult any peer
 *
 * Returns a no-op tool if nobody is consultable (edge case — only CMO
 * registered, etc.).
 */
export function makeConsultTool(selfId: EmployeeId) {
	const callable = EMPLOYEE_IDS.filter((id) => {
		if (id === selfId) return false;
		if (selfId !== "cmo" && id === "cmo") return false;
		return true;
	});

	if (callable.length === 0) {
		return tool({
			description: "No colleagues available to consult.",
			inputSchema: z.object({ employee: z.never() }),
			execute: async () => ({
				answer: "No colleagues are currently available.",
			}),
		});
	}

	const employeeEnum = z
		.enum(callable as [EmployeeId, ...EmployeeId[]])
		.describe(
			callable
				.map((id) => {
					const meta = EMPLOYEE_REGISTRY[id]!;
					return `'${id}': ${meta.displayName} — ${meta.description}`;
				})
				.join("\n"),
		);

	return tool({
		description:
			"Consult a colleague for their expertise. Returns their final response and any structured artifacts they produced.",
		inputSchema: z.object({
			employee: employeeEnum,
			question: z.string().describe("What you want to ask them"),
			context: z
				.string()
				.optional()
				.describe("Background information they need to answer well"),
		}),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		execute: async ({ employee, question, context }, ctx: any) => {
			const meta = EMPLOYEE_REGISTRY[employee as EmployeeId];
			if (!meta) {
				return { ok: false as const, error: `Unknown employee: ${employee}` };
			}
			const peerTool = getPeerTools()[employee as EmployeeId];
			if (!peerTool || !peerTool.execute) {
				return {
					ok: false as const,
					error: `No agentTool available for ${employee}.`,
				};
			}
			safeAgentChain.check(ctx, meta.class.name);
			return await peerTool.execute({ question, context }, ctx);
		},
	});
}
