import {
  env,
  createScheduledController,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

/**
 * Tests for `scheduled()` cron fan-out — S2.6.
 *
 * Phase 0 spike #9: `SELF.scheduled()` is broken in vitest-pool-workers,
 * so we invoke `worker.scheduled!(ctl, env, ctx)` directly per the
 * project guidance.
 *
 * Coverage:
 *  - Empty-user-table happy path (resolves without throwing — Promise.allSettled
 *    over an empty array).
 *  - Self-healing on D1 failure (the try/catch swallows + logs; the
 *    handler still resolves).
 *
 * A meaningful end-to-end test (seed a user row → assert the CMO DO got a
 * `/internal/cron-tick` request) needs the D1 migration applied at test
 * setup, which we don't do here yet. Real coverage lands when there's an
 * SMM with a mockable inbound sweep (post-S4) — see task brief.
 */

describe("Worker scheduled() cron fan-out", () => {
  it("resolves without throwing when no users exist", async () => {
    const ctl = createScheduledController({
      scheduledTime: Date.now(),
      cron: "0 * * * *",
    });
    const ctx = createExecutionContext();
    await expect(worker.scheduled!(ctl, env, ctx)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  });

  it("swallows errors from a broken D1 binding (self-healing)", async () => {
    // Simulate the prod scenario where D1 read fails (transient outage,
    // schema drift, etc.). The handler's outer try/catch must convert this
    // into a successful resolve so the cron tick doesn't get retried in a
    // tight loop.
    const ctl = createScheduledController({
      scheduledTime: Date.now(),
      cron: "0 * * * *",
    });
    const ctx = createExecutionContext();
    const brokenEnv = {
      ...env,
      DB: {
        // Drizzle's d1 driver calls `.prepare(...)` first thing; throw there.
        prepare: () => {
          throw new Error("simulated D1 outage");
        },
      } as unknown as D1Database,
    };
    await expect(
      worker.scheduled!(ctl, brokenEnv, ctx),
    ).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  });
});
