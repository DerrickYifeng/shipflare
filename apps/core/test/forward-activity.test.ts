import { describe, expect, it, vi } from "vitest";
import { forwardActivityToCmo } from "../src/lib/forward-activity";
import type { Env } from "../src/index";

/**
 * Unit tests for the cross-DO activity forwarder (spec
 * 2026-05-15-agent-activity-feed-design §5.2).
 *
 * The helper is fire-and-forget: it must POST to the CMO DO's
 * `/internal/log-activity` endpoint with the internal-call header, and
 * it must NOT throw if the fetch rejects (downed CMO must not crash
 * sub-agent work).
 *
 * The CMO binding is faked structurally — we cast the fake to `Env` for
 * the call site since vitest tests don't run inside a real Worker.
 */

describe("forwardActivityToCmo", () => {
  it("POSTs to /internal/log-activity with the internal header", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const fakeStub = { fetch: fetchSpy };
    const env = {
      CMO: { idFromName: (n: string) => n, get: () => fakeStub },
    } as unknown as Env;

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    };

    forwardActivityToCmo(ctx, env, "user-1", {
      conversationId: null,
      parentTurnId: null,
      runId: "run-1",
      sourceAgent: "head-of-growth",
      parentEventId: null,
      kind: "subagent_text_delta",
      payload: { kind: "subagent_text_delta", subAgent: "head-of-growth", text: "hi" },
    });
    await Promise.all(pending);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const call = fetchSpy.mock.calls[0]!;
    const [url, init] = call as [string | URL | Request, RequestInit & { headers: Record<string, string>; body: string }];
    expect(String(url)).toContain("/internal/log-activity");
    expect(init.method).toBe("POST");
    expect(init.headers["x-shipflare-internal"]).toBe("1");
    const body = JSON.parse(init.body);
    expect(body.kind).toBe("subagent_text_delta");
  });

  it("swallows fetch errors (fire-and-forget)", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("boom"));
    const fakeStub = { fetch: fetchSpy };
    const env = {
      CMO: { idFromName: (n: string) => n, get: () => fakeStub },
    } as unknown as Env;
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    };

    expect(() =>
      forwardActivityToCmo(ctx, env, "user-1", {
        conversationId: null,
        parentTurnId: null,
        runId: null,
        sourceAgent: "head-of-growth",
        parentEventId: null,
        kind: "turn_start",
        payload: { kind: "turn_start" },
      }),
    ).not.toThrow();
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });
});
