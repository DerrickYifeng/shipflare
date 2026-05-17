import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { SMM } from "../../src/agents/social-media-manager/SocialMediaMgr";

/**
 * SMM as AIChatAgent — smoke tests.
 *
 * Task 4.4c+d of the CF-native chat migration: replaces the seven McpAgent-era
 * tests (smm-schema, smm-find-threads, smm-process-replies, …) with a single
 * canonical surface check. The full chat round-trip is deliberately out of
 * scope here — it would require mocking `@ai-sdk/anthropic` at the worker
 * bundle level, which is much harder than asserting the DO boots and exposes
 * the expected tool shape.
 *
 * If `env.SMM` is unresolved at test time, the vitest-pool-workers config may
 * not have picked up the wrangler.jsonc binding rename — verify the migration
 * tag v10 is present and re-run.
 */
describe("SMM as AIChatAgent", () => {
	it("DO boots with initialState shape", async () => {
		const id = env.SMM.idFromName("smm-test-boot");
		await runInDurableObject<SMM, void>(env.SMM.get(id), async (instance) => {
			// AIChatAgent exposes state via Agent's state primitive.
			expect(instance.state).toBeDefined();
			expect(instance.state.currentRunId).toBeNull();
		});
	});

	it("getTools() returns consult + draft_for_channel", async () => {
		const id = env.SMM.idFromName("smm-test-tools");
		await runInDurableObject<SMM, void>(env.SMM.get(id), async (instance) => {
			const tools = instance.getTools();
			expect(Object.keys(tools).sort()).toEqual(
				["consult", "draft_for_channel", "find_threads_via_xai"].sort(),
			);
		});
	});
});
