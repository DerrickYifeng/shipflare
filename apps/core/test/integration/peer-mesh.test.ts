import { describe, it, expect } from "vitest";
import {
  AgentCycleError,
  AgentDepthExceededError,
} from "../../src/lib/agent-depth";
import { makeConsultTool } from "../../src/agents/lib/consult-tool";

/**
 * Phase 4 peer-mesh tests — verify the consult-tool's safeAgentChain check
 * fires correctly on the cycle and depth-exceeded paths.
 *
 * The end-to-end SMM → HoG chat round-trip (plan §Task 4.8 Step 1) requires
 * either real Anthropic API access or a heavy `@ai-sdk/anthropic` module mock
 * inside vitest-pool-workers. Deferred to Phase 11 (manual / Playwright
 * smoke). The two tests below are the unit-style proxies that catch the
 * regressions Task 4.8 actually cares about.
 */
describe("peer mesh — consult tool chain safety", () => {
  it("throws AgentCycleError when target already in __agentChain", async () => {
    const t = makeConsultTool("smm");
    // Primed chain has 'HoG' already; SMM trying to consult HoG triggers cycle.
    // (The HoG class is registered as `HoG` — class.name returns the exact string.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx: any = { props: { __agentChain: ["HoG", "SMM"] } };

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t as any).execute({ employee: "hog", question: "loop test" }, ctx),
    ).rejects.toThrow(AgentCycleError);
  });

  it("throws AgentDepthExceededError when chain length === MAX_AGENT_DEPTH", async () => {
    const t = makeConsultTool("smm");
    // Chain of 3 (== MAX_AGENT_DEPTH) — any further push throws.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx: any = { props: { __agentChain: ["CMO", "HoG", "SMM"] } };

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t as any).execute({ employee: "hog", question: "depth test" }, ctx),
    ).rejects.toThrow(AgentDepthExceededError);
  });

  it("succeeds when chain has room (length < MAX_AGENT_DEPTH)", async () => {
    const t = makeConsultTool("smm");
    // Empty chain — consult should proceed past the safety check. The
    // underlying `agentTool.execute(...)` call will then attempt to dispatch
    // to HoG; in vitest-pool-workers this may succeed with a mocked response,
    // fail at the model call, or return a structured error — we only assert
    // the safety check did NOT trip (no throw of AgentCycleError or
    // AgentDepthExceededError). Any other outcome is acceptable here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx: any = { props: {} };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t as any).execute(
        { employee: "hog", question: "happy path" },
        ctx,
      );
    } catch (err) {
      // We allow ANY error here EXCEPT our own safety-check throws.
      expect(err).not.toBeInstanceOf(AgentCycleError);
      expect(err).not.toBeInstanceOf(AgentDepthExceededError);
    }
    // safeAgentChain mutated ctx.props.__agentChain in place — verify it
    // was extended (this is the side effect that prevents cycles in a real
    // dispatch chain).
    expect(ctx.props.__agentChain).toEqual(["HoG"]);
  });
});
