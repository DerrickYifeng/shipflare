import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// Spike #7 — Dynamic Workflow.
//
// Asserts that `step.do(A) → step.sleep(5s) → step.do(B)` completes cleanly
// and that the wall-clock duration between A and B is at least 5s (i.e. the
// platform actually slept). vitest-pool-workers' Workflow simulation may
// differ from production (the simulator can occasionally short-circuit sleep);
// see RESULTS.md for documented divergence.

interface WorkflowStatus {
  status: string;
  output?: {
    a: { tag: string; ts: number };
    b: { tag: string; ts: number };
    durationMs: number;
    runId: string;
  };
}

async function pollUntilTerminal(id: string, timeoutMs = 60_000): Promise<WorkflowStatus> {
  const start = Date.now();
  let last: WorkflowStatus | null = null;
  while (Date.now() - start < timeoutMs) {
    const res = await SELF.fetch(`https://example.com/spike/07/status?id=${id}`);
    const body = (await res.json()) as { status: WorkflowStatus };
    last = body.status;
    if (body.status.status === "complete") return body.status;
    if (body.status.status === "errored" || body.status.status === "terminated") {
      throw new Error(`Workflow ended in non-success state: ${JSON.stringify(body)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Workflow timeout. Last status: ${JSON.stringify(last)}`);
}

describe("Spike #7: Dynamic Workflow", () => {
  it("step.do → step.sleep(5s) → step.do completes with duration >= 5s", async () => {
    const createRes = await SELF.fetch("https://example.com/spike/07");
    expect(createRes.status).toBe(200);
    const { id } = (await createRes.json()) as { id: string };
    expect(id).toBeTruthy();

    const status = await pollUntilTerminal(id);
    expect(status.status).toBe("complete");
    expect(status.output).toBeDefined();
    expect(status.output!.a.tag).toBe("A");
    expect(status.output!.b.tag).toBe("B");
    expect(status.output!.durationMs).toBeGreaterThanOrEqual(5000);
  }, 90_000);
});
