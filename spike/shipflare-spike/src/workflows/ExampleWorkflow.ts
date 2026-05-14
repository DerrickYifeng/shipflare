// Spike #7 — Dynamic Workflow primitive.
//
// Validates the `step.do(...) → step.sleep(...) → step.do(...)` shape that
// ShipFlare's Phase 1 `AgentPlanWorkflow` relies on: "post X, wait 2h, check
// metrics, conditionally post Reddit". Each step is checkpointed by the
// platform so eviction during the sleep window must NOT lose state — the
// second step.do must observe the first step's output unchanged on resume.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../index";

type Params = { runId: string };

type StepAResult = { ts: number; tag: "A" };
type StepBResult = { ts: number; tag: "B" };

export class ExampleWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const a: StepAResult = await step.do("step-a", async () => ({
      ts: Date.now(),
      tag: "A" as const,
    }));

    // 5s is the smallest window that proves sleep actually suspends — short
    // enough for vitest to poll through, long enough that "completed in <1s"
    // would mean the simulator skipped the sleep.
    await step.sleep("step-sleep", "5 seconds");

    const b: StepBResult = await step.do("step-b", async () => ({
      ts: Date.now(),
      tag: "B" as const,
    }));

    return {
      runId: event.payload.runId,
      a,
      b,
      durationMs: b.ts - a.ts,
    };
  }
}
