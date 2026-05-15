import { describe, it, expect } from "vitest";
import { validateLaunchDates } from "../../src/lib/launch-date-rules";

describe("validateLaunchDates", () => {
  const now = new Date("2026-05-15T00:00:00Z").getTime();

  it("launching requires launchDate", () => {
    const errs = validateLaunchDates({ state: "launching", launchDate: null, launchedAt: null }, now);
    expect(errs).toHaveLength(1);
    expect(errs[0].field).toBe("launchDate");
  });

  it("launching accepts a date 30 days from now", () => {
    const d = new Date(now + 30 * 86_400_000).toISOString();
    const errs = validateLaunchDates({ state: "launching", launchDate: d, launchedAt: null }, now);
    expect(errs).toHaveLength(0);
  });

  it("launching rejects a date 100 days from now", () => {
    const d = new Date(now + 100 * 86_400_000).toISOString();
    const errs = validateLaunchDates({ state: "launching", launchDate: d, launchedAt: null }, now);
    expect(errs).toHaveLength(1);
  });

  it("launched requires launchedAt", () => {
    const errs = validateLaunchDates({ state: "launched", launchDate: null, launchedAt: null }, now);
    expect(errs).toHaveLength(1);
    expect(errs[0].field).toBe("launchedAt");
  });
});
