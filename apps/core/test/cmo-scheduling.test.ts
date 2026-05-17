import { describe, expect, it } from "vitest";
import { computeNextDailyAt } from "../src/agents/cmo/scheduling";

describe("computeNextDailyAt", () => {
  it("returns today's instance if hour is in the future in tz (UTC)", () => {
    // 2026-05-17 08:00 UTC; tz=UTC; hour=9 → 09:00 UTC today
    const now = Date.UTC(2026, 4, 17, 8, 0, 0);
    const next = computeNextDailyAt("UTC", 9, now);
    expect(new Date(next).toISOString()).toBe("2026-05-17T09:00:00.000Z");
  });

  it("returns tomorrow's instance if hour already passed (UTC)", () => {
    const now = Date.UTC(2026, 4, 17, 10, 0, 0); // 10:00 UTC, past 9:00
    const next = computeNextDailyAt("UTC", 9, now);
    expect(new Date(next).toISOString()).toBe("2026-05-18T09:00:00.000Z");
  });

  it("handles America/New_York EDT (UTC-4 in June)", () => {
    // 2026-06-01 12:00 UTC = 08:00 EDT. Next 9am EDT = 13:00 UTC same day.
    const now = Date.UTC(2026, 5, 1, 12, 0, 0);
    const next = computeNextDailyAt("America/New_York", 9, now);
    expect(new Date(next).toISOString()).toBe("2026-06-01T13:00:00.000Z");
  });

  it("handles Asia/Hong_Kong HKT (UTC+8 year-round)", () => {
    // 2026-05-17 02:00 UTC = 10:00 HKT (past 9am). Next 9am HKT = 2026-05-18 01:00 UTC.
    const now = Date.UTC(2026, 4, 17, 2, 0, 0);
    const next = computeNextDailyAt("Asia/Hong_Kong", 9, now);
    expect(new Date(next).toISOString()).toBe("2026-05-18T01:00:00.000Z");
  });

  it("handles America/New_York EST (UTC-5 in November)", () => {
    // 2026-11-02 13:00 UTC = 08:00 EST (after fall-back). Next 9am EST = 14:00 UTC same day.
    const now = Date.UTC(2026, 10, 2, 13, 0, 0);
    const next = computeNextDailyAt("America/New_York", 9, now);
    expect(new Date(next).toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });

  it("rejects out-of-range hour", () => {
    expect(() => computeNextDailyAt("UTC", -1, Date.now())).toThrow();
    expect(() => computeNextDailyAt("UTC", 24, Date.now())).toThrow();
    expect(() => computeNextDailyAt("UTC", 1.5, Date.now())).toThrow();
  });
});
