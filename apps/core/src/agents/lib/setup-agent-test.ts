import type { EmployeeId } from "../registry";

/**
 * Test helper for AIChatAgent integration tests. Wraps DO stub access
 * + JSON request construction for the chat surface.
 *
 * NOT meant for unit tests that just need `runInDurableObject` against
 * the DO instance — use that directly. This helper is for tests that
 * want to drive a full chat round-trip via `stub.fetch(...)`.
 *
 * The `env` import is from `cloudflare:test` (vitest-pool-workers).
 * Callers pass it in to avoid this module being entangled with
 * test-only globals at the type level.
 */
export interface AgentTestHandle {
	stub: DurableObjectStub;
	userId: string;
	sendMessage(content: string): Promise<Response>;
}

export function setupAgentTest(
	env: Record<string, unknown>,
	id: EmployeeId,
	userId = `test-${id}`,
): AgentTestHandle {
	const bindingName = id.toUpperCase(); // 'cmo' → 'CMO', 'hog' → 'HOG', 'smm' → 'SMM'
	const ns = env[bindingName] as DurableObjectNamespace | undefined;
	if (!ns) {
		throw new Error(
			`setupAgentTest: env.${bindingName} is missing — is the wrangler binding configured?`,
		);
	}
	const stub = ns.get(ns.idFromName(userId));
	return {
		stub,
		userId,
		async sendMessage(content: string): Promise<Response> {
			return stub.fetch(
				`https://internal/agents/${id}/${userId}/chat`,
				{
					method: "POST",
					body: JSON.stringify({
						messages: [{ role: "user", content }],
					}),
				},
			);
		},
	};
}
