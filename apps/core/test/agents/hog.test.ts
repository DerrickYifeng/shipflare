import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { HoG } from "../../src/agents/head-of-growth/HeadOfGrowth";

/**
 * HoG as AIChatAgent — smoke tests.
 *
 * Task 4.5b of the CF-native chat migration: replaces the three McpAgent-era
 * tests (hog-schema, hog-audit-plan, hog-strategic-path) with a single
 * canonical surface check. The full chat round-trip is deliberately out of
 * scope here — it would require mocking `@ai-sdk/anthropic` at the worker
 * bundle level, which is much harder than asserting the DO boots and exposes
 * the expected tool shape.
 *
 * If `env.HOG` is unresolved at test time, the vitest-pool-workers config may
 * not have picked up the wrangler.jsonc binding rename — verify the migration
 * tag v11 is present and re-run.
 */
describe("HoG as AIChatAgent", () => {
	it("DO boots with initialState shape", async () => {
		const id = env.HOG.idFromName("hog-test-boot");
		await runInDurableObject<HoG, void>(env.HOG.get(id), async (instance) => {
			// AIChatAgent exposes state via Agent's state primitive.
			expect(instance.state).toBeDefined();
			expect(instance.state.currentRunId).toBeNull();
		});
	});

	it("getTools() returns consult + generate_strategic_path + audit_plan", async () => {
		const id = env.HOG.idFromName("hog-test-tools");
		await runInDurableObject<HoG, void>(env.HOG.get(id), async (instance) => {
			const tools = instance.getTools();
			expect(Object.keys(tools).sort()).toEqual(["consult", "generate_strategic_path", "audit_plan"].sort());
		});
	});
});
