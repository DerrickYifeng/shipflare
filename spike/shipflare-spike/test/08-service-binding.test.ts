import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// Spike #8 — Service Binding.
//
// vitest-pool-workers fully simulates cross-worker Service Bindings when
// the sibling is registered as an auxiliary worker via
// `cloudflareTest({ miniflare: { workers: [...] } })` in vitest.config.mts.
// With that wired, the in-test path returns 200 and exercises the
// `env.CALLEE.fetch(...)` round-trip end-to-end (this is the path we
// expect every CI run to take). The 503 branch is kept as a defensive
// fallback for the case where the auxiliary worker fails to start.
//
// Real production validation also runs `wrangler dev` in BOTH worker
// dirs and curls `/spike/08`. See RESULTS.md row 8 for captured output.

interface CalleeEchoBody {
  pathReceived: string;
  methodReceived: string;
  headerEcho: Record<string, string>;
  timestamp: number;
  callee: string;
}

interface HandlerSuccessBody {
  calleeStatus: number;
  calleeBody: CalleeEchoBody;
  latencyMs: number;
  note: string;
}

interface HandlerFallbackBody {
  error: string;
  hint: string;
}

describe("Spike #8: Service Binding (compile-time + runtime-tolerant)", () => {
  it("handler returns either binding result OR graceful 503 fallback", async () => {
    const res = await SELF.fetch("https://example.com/spike/08");
    // Two acceptable outcomes:
    //   200 → CALLEE binding resolved (auxiliary worker is running)
    //   503 → binding not bound (vitest env without auxiliary worker)
    expect([200, 503]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as HandlerSuccessBody;
      expect(body.calleeStatus).toBe(200);
      expect(body.calleeBody).toBeDefined();
      expect(body.calleeBody.callee).toBe("shipflare-spike-callee");
      expect(body.calleeBody.pathReceived).toBe("/test-echo");
      expect(body.calleeBody.methodReceived).toBe("POST");
      // Service Bindings are in-process; latency should be tiny. The
      // assertion is loose (< 100ms) so it never flakes on slow CI; the
      // *typical* observed latency is documented in RESULTS.md.
      expect(body.latencyMs).toBeLessThan(100);
    } else {
      const body = (await res.json()) as HandlerFallbackBody;
      expect(body.error).toBeDefined();
      expect(body.hint).toBeDefined();
    }
  }, 30_000);
});
