import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { CMO } from "../../src/agents/cmo/CMO";

/**
 * CMO as AIChatAgent — smoke tests.
 *
 * Task 5.1b of the CF-native chat migration: replaces the McpAgent-era
 * CMO test suite (cmo-chat, cmo-conversation, cmo-roster, cmo-shared-state,
 * chat-activity, delegate-activity, get-recent-activity) with a single
 * canonical surface check. The full chat round-trip is deliberately out
 * of scope here — exercising `onChatMessage` would require mocking
 * `@ai-sdk/anthropic` at the worker bundle level. SQL persistence and
 * route gating are covered separately by `cmo-memory.test.ts`,
 * `cmo-schema.test.ts`, `cmo-internal.test.ts`, and `cmo-routing.test.ts`.
 *
 * If `env.CMO` is unresolved at test time, the vitest-pool-workers config
 * may not have picked up the wrangler.jsonc migration tag v12 — re-run.
 */
describe("CMO as AIChatAgent", () => {
	it("DO boots with initialState shape", async () => {
		const id = env.CMO.idFromName("cmo-test-boot");
		await runInDurableObject<CMO, void>(env.CMO.get(id), async (instance) => {
			expect(instance.state).toBeDefined();
			expect(instance.state.currentRunId).toBeNull();
		});
	});

	it("getTools() exposes consult + 14 shared-state tools", async () => {
		const id = env.CMO.idFromName("cmo-test-tools");
		await runInDurableObject<CMO, void>(env.CMO.get(id), async (instance) => {
			const tools = instance.getTools();
			const names = Object.keys(tools).sort();
			expect(names).toContain("consult");
			expect(names).toContain("queryFounderContext");
			expect(names).toContain("setFounderContext");
			expect(names).toContain("commitStrategicPath");
			expect(names).toContain("addPlanItem");
			expect(names).toContain("queryPlanItems");
			expect(names).toContain("updatePlanItem");
			expect(names).toContain("cancelPlanItem");
			expect(names).toContain("approveDraft");
			expect(names).toContain("rejectDraft");
			expect(names).toContain("queryDrafts");
			expect(names).toContain("rememberThis");
			expect(names).toContain("forgetThis");
			expect(names).toContain("queryMemory");
			expect(names).toContain("queryAgentTranscript");
			expect(names.length).toBe(15);
		});
	});
});
