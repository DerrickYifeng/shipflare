import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import type { CMO } from "../src/agents/cmo/CMO";

describe("CMO.scheduleNextRelayAlarm + setFounderContext hook", () => {
  it("setFounderContext({key:'tz'}) schedules an alarm", async () => {
    const userId = "alarm-tz-1";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await runInDurableObject<CMO, void>(stub, async (_inst, state) =>
      applyCmoSchema(state.storage.sql),
    );

    await runInDurableObject<CMO, void>(stub, async (instance, state) => {
      // Confirm no alarm initially
      expect(await state.storage.getAlarm()).toBeNull();

      // Drive setFounderContext via the LLM tool — for testing, call the tool's
      // execute closure directly using the agent's getTools().
      const tools = instance.getTools();
      await tools.setFounderContext!.execute!(
        { key: "tz", value: "America/New_York" },
        {} as never,
      );

      const alarmMs = await state.storage.getAlarm();
      expect(alarmMs).not.toBeNull();
      expect(alarmMs!).toBeGreaterThan(Date.now());
      // Within 25 hours from now (handles cross-DST + the test running near 9am edge)
      expect(alarmMs! - Date.now()).toBeLessThan(25 * 3600 * 1000);
    });
  });

  it("setFounderContext({key:'relayHourLocal'}) reschedules alarm", async () => {
    const userId = "alarm-tz-2";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await runInDurableObject<CMO, void>(stub, async (_inst, state) =>
      applyCmoSchema(state.storage.sql),
    );

    await runInDurableObject<CMO, void>(stub, async (instance, state) => {
      const tools = instance.getTools();
      await tools.setFounderContext!.execute!(
        { key: "tz", value: "UTC" },
        {} as never,
      );
      const first = await state.storage.getAlarm();

      await tools.setFounderContext!.execute!(
        { key: "relayHourLocal", value: "15" },
        {} as never,
      );
      const second = await state.storage.getAlarm();

      expect(second).not.toBe(first); // alarm time changed
      expect(second).not.toBeNull();
    });
  });

  it("setFounderContext for unrelated keys does NOT touch the alarm", async () => {
    const userId = "alarm-tz-3";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await runInDurableObject<CMO, void>(stub, async (_inst, state) =>
      applyCmoSchema(state.storage.sql),
    );

    await runInDurableObject<CMO, void>(stub, async (instance, state) => {
      const tools = instance.getTools();
      // First, set tz to establish a baseline alarm
      await tools.setFounderContext!.execute!(
        { key: "tz", value: "UTC" },
        {} as never,
      );
      const baseline = await state.storage.getAlarm();

      // Now set an unrelated key
      await tools.setFounderContext!.execute!(
        { key: "productName", value: "TestProd" },
        {} as never,
      );

      const after = await state.storage.getAlarm();
      expect(after).toBe(baseline); // unchanged
    });
  });
});
