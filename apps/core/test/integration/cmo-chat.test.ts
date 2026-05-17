import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { setupAgentTest } from "../../src/agents/lib/setup-agent-test";

/**
 * CMO chat-flow integration tests.
 *
 * ## Scope
 *
 * This file covers what is feasible in the vitest-pool-workers layer.
 * Three categories of test were considered for Task 5.2 + 5.3; the
 * disposition of each is documented below.
 *
 * ### DEFERRED — streams text-delta and persists message
 * Driving a real streaming response requires Anthropic API access inside
 * the miniflare worker process. Even with ANTHROPIC_API_KEY present in
 * .dev.vars, the AI SDK streams back over a ReadableStream that
 * vitest-pool-workers does not easily surface through `stub.fetch`. The
 * AIChatAgent chat path also expects a specific WebSocket or
 * streamable-HTTP handshake that vitest-pool-workers' miniflare layer
 * does not set up when driving via plain `stub.fetch`. Deferred to
 * Phase 11 Playwright per spec §11.3.
 *
 * ### DEFERRED — dispatches consult to HoG when prompted
 * Requires the LLM to actually call the `consult` tool, which means
 * a real API round-trip AND a functioning AIChatAgent chat transport.
 * Same constraint as above. Deferred to Phase 11.
 *
 * ### DEFERRED — writes telemetry on turn finish (originally Task 5.2 #3)
 * `writeAgentEvent` inside CMO's `onChatMessage.onFinish` reads
 * `this.env.TELEMETRY`. Module-level mocks via `vi.mock("@shipflare/shared")`
 * do not propagate into the DO worker bundle: vitest-pool-workers builds the
 * worker bundle separately from the test bundle, so the mock runs in the test
 * process but the DO executes the real implementation. Deferred to Phase 11.
 *
 * ### IMPLEMENTED — setupAgentTest helper smoke test
 * Verifies that:
 *   1. The helper compiles and resolves the correct DO namespace from env.
 *   2. The `stub` and `sendMessage` fields have the expected types.
 *   3. Calling `sendMessage` reaches the CMO DO and returns a Response
 *      without throwing (the response may be a non-ok status if the chat
 *      transport is not fully wired in miniflare, but no exception should
 *      propagate to the test layer).
 *
 * This provides real value: it confirms the helper itself is wired correctly
 * and that the CMO DO is reachable under the expected binding name. The
 * broader chat-flow assertions land via Playwright in Phase 11 per spec §11.3.
 */

describe("setupAgentTest helper — smoke", () => {
  it("returns a handle with stub + userId + sendMessage", () => {
    const handle = setupAgentTest(env as unknown as Record<string, unknown>, "cmo", "chat-smoke-1");
    expect(handle.stub).toBeDefined();
    expect(handle.userId).toBe("chat-smoke-1");
    expect(typeof handle.sendMessage).toBe("function");
  });

  it("throws if binding is absent from env", () => {
    expect(() =>
      setupAgentTest({}, "cmo", "no-binding"),
    ).toThrow("env.CMO is missing");
  });

  it("sendMessage returns a Response without throwing", async () => {
    const { sendMessage } = setupAgentTest(
      env as unknown as Record<string, unknown>,
      "cmo",
      "chat-smoke-2",
    );
    // We expect a Response back. The status may be non-ok (AIChatAgent's
    // chat route expects specific framing that plain fetch doesn't provide),
    // but no uncaught exception should propagate out of sendMessage.
    const res = await sendMessage("hello");
    expect(res).toBeInstanceOf(Response);
  });
});
