import {
  SELF,
  createScheduledController,
  createExecutionContext,
  waitOnExecutionContext,
  env,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

// Spike #9 — Cron fan-out.
//
// Validates that wrangler `triggers.crons` fires the `scheduled()` Worker
// handler and that the handler can fan out to a Durable Object. The test
// pool's `SELF.scheduled(...)` is a `LoopbackServiceStub` that fails to
// serialize the call (DataCloneError on `LoopbackServiceStub`), so instead
// we call the worker's exported `scheduled` handler directly with
// `createScheduledController` + `createExecutionContext` (the canonical
// pattern documented in `cloudflare:test` types). This is functionally
// equivalent to a cron tick from the platform's scheduler.
//
// The DO under test (`SqliteDO`'s `cron-target` instance) accumulates
// markers we can observe via the GET handler at `/spike/09`.
//
// NOTE: within a single test file the DO instance is shared across tests, so
// markers from earlier tests carry over. Across files (or `vitest run`
// invocations) miniflare resets local DO state. The second test below uses
// a pre/post snapshot to assert the delta, not exact totals.

async function triggerCron(scheduledTime: number, cron = "*/1 * * * *"): Promise<void> {
  const ctl = createScheduledController({
    scheduledTime: new Date(scheduledTime),
    cron,
  });
  const ctx = createExecutionContext();
  // `worker.scheduled` is guaranteed by `satisfies ExportedHandler<Env>` in src/index.ts.
  await worker.scheduled!(ctl, env as unknown as Parameters<NonNullable<typeof worker.scheduled>>[1], ctx);
  await waitOnExecutionContext(ctx);
}

describe("Spike #9: Cron fan-out", () => {
  it("scheduled() handler fires and fans out a marker to the DO", async () => {
    // Use a deterministic scheduledTime far enough in the past that we can
    // assert exact echo without colliding with `Date.now()` from earlier tests.
    const scheduledTime = 1_700_000_000_000; // 2023-11-14T22:13:20Z
    await triggerCron(scheduledTime);

    const probe = await SELF.fetch("https://example.com/spike/09");
    expect(probe.status).toBe(200);
    const body = (await probe.json()) as {
      markerCount: number;
      recent: Array<{ ts: number; content: string }>;
    };
    expect(body.markerCount).toBeGreaterThanOrEqual(1);

    // The recent list is DESC by ts. Assert by inclusion (not position) so
    // any prior test's markers don't break us.
    const matching = body.recent.find((r) => r.ts === scheduledTime);
    expect(matching).toBeDefined();
    expect(matching!.content).toBe(`cron@${scheduledTime}`);
  }, 30_000);

  it("multiple cron ticks accumulate in the DO", async () => {
    // Snapshot pre-count so we assert the +2 delta independent of prior markers.
    const before = (await (await SELF.fetch("https://example.com/spike/09")).json()) as {
      markerCount: number;
    };

    const t1 = 1_700_000_001_000;
    await triggerCron(t1);
    const t2 = 1_700_000_002_000;
    await triggerCron(t2);

    const after = (await (await SELF.fetch("https://example.com/spike/09")).json()) as {
      markerCount: number;
      recent: Array<{ ts: number }>;
    };
    expect(after.markerCount).toBeGreaterThanOrEqual(before.markerCount + 2);

    const tsSet = new Set(after.recent.map((r) => r.ts));
    expect(tsSet.has(t1)).toBe(true);
    expect(tsSet.has(t2)).toBe(true);
  }, 30_000);
});
