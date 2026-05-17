import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import type { CMO } from "../src/agents/cmo/CMO";

describe("CMO bootstrapTzIfMissing", () => {
  it("writes inferred TZ to founder_context on first call + schedules alarm", async () => {
    const userId = "tzboot-1";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await runInDurableObject<CMO, void>(stub, async (_inst, state) => applyCmoSchema(state.storage.sql));

    await runInDurableObject<CMO, void>(stub, async (instance, state) => {
      // No prior alarm
      expect(await state.storage.getAlarm()).toBeNull();

      await (instance as unknown as { bootstrapTzIfMissing: (tz: string) => Promise<void> })
        .bootstrapTzIfMissing("Asia/Hong_Kong");

      // founder_context.tz populated
      const rows = state.storage.sql
        .exec("SELECT value FROM founder_context WHERE key = 'tz'")
        .toArray() as Array<{ value: string }>;
      expect(rows[0]!.value).toBe("Asia/Hong_Kong");

      // Alarm scheduled
      const alarmMs = await state.storage.getAlarm();
      expect(alarmMs).not.toBeNull();
      expect(alarmMs!).toBeGreaterThan(Date.now());
    });
  });

  it("does NOT overwrite existing tz; does not change existing alarm", async () => {
    const userId = "tzboot-2";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await runInDurableObject<CMO, void>(stub, async (_inst, state) => {
      applyCmoSchema(state.storage.sql);
      state.storage.sql.exec(
        "INSERT INTO founder_context (key, value) VALUES (?, ?)",
        "tz", "America/New_York",
      );
    });

    await runInDurableObject<CMO, void>(stub, async (instance, state) => {
      const alarmBefore = await state.storage.getAlarm();

      await (instance as unknown as { bootstrapTzIfMissing: (tz: string) => Promise<void> })
        .bootstrapTzIfMissing("Asia/Hong_Kong");

      // Still has the original tz
      const rows = state.storage.sql
        .exec("SELECT value FROM founder_context WHERE key = 'tz'")
        .toArray() as Array<{ value: string }>;
      expect(rows[0]!.value).toBe("America/New_York");

      // Alarm unchanged (or still null if it was)
      const alarmAfter = await state.storage.getAlarm();
      expect(alarmAfter).toBe(alarmBefore);
    });
  });
});
