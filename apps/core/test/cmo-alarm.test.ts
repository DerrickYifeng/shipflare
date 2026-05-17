import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import type { CMO } from "../src/agents/cmo/CMO";

describe("CMO alarm()", () => {
  it("skips synthetic turn when productName is missing; still reschedules", async () => {
    const userId = "alarm-skip-1";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await runInDurableObject<CMO, void>(stub, async (_inst, state) =>
      applyCmoSchema(state.storage.sql),
    );

    await runInDurableObject<CMO, void>(stub, async (instance, state) => {
      // No productName set — alarm should skip the turn and reschedule.
      await instance.alarm();
      const next = await state.storage.getAlarm();
      expect(next).not.toBeNull();
      expect(next!).toBeGreaterThan(Date.now());
    });
  });

  it("fires synthetic turn when productName is set (dry-run mode)", async () => {
    const userId = "alarm-fire-1";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await runInDurableObject<CMO, void>(stub, async (_inst, state) => {
      applyCmoSchema(state.storage.sql);
      state.storage.sql.exec(
        "INSERT INTO founder_context (key, value) VALUES (?, ?)",
        "productName",
        "TestProd",
      );
    });

    await runInDurableObject<CMO, void>(stub, async (instance, state) => {
      // Set dry-run flag so alarm() emits telemetry but skips the actual LLM turn
      // (vi.mock doesn't propagate into the worker bundle per resume note).
      (instance as unknown as { _alarmDryRun?: boolean })._alarmDryRun = true;
      await instance.alarm();
      const next = await state.storage.getAlarm();
      expect(next).not.toBeNull();
    });
  });

  it("always reschedules even if synthetic turn throws", async () => {
    const userId = "alarm-fail-1";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await runInDurableObject<CMO, void>(stub, async (_inst, state) => {
      applyCmoSchema(state.storage.sql);
      state.storage.sql.exec(
        "INSERT INTO founder_context (key, value) VALUES (?, ?)",
        "productName",
        "TestProd",
      );
    });

    await runInDurableObject<CMO, void>(stub, async (instance, state) => {
      // Inject a failure mode — alarm() will route through the failure-injection
      // branch instead of calling runRelayTurn(), so we exercise the
      // self-healing "always reschedule" guarantee without needing the LLM.
      (instance as unknown as { _alarmInjectError?: string })._alarmInjectError =
        "synthetic test failure";
      await instance.alarm();
      // Alarm should be rescheduled despite the throw — self-healing per spec.
      const next = await state.storage.getAlarm();
      expect(next).not.toBeNull();
      expect(next!).toBeGreaterThan(Date.now());
    });
  });
});
