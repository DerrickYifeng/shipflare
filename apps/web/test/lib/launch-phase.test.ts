import { describe, it, expect } from "vitest";
import { derivePhase } from "../../src/lib/launch-phase";

describe("derivePhase", () => {
  const now = new Date("2026-05-15T00:00:00Z");

  it("returns steady for launched without launchedAt", () => {
    expect(derivePhase({ state: "launched", launchDate: null, launchedAt: null, now })).toBe("steady");
  });

  it("returns compound within 30 days of launch", () => {
    const launchedAt = new Date("2026-04-30T00:00:00Z");
    expect(derivePhase({ state: "launched", launchDate: null, launchedAt, now })).toBe("compound");
  });

  it("returns foundation for mvp without launchDate", () => {
    expect(derivePhase({ state: "mvp", launchDate: null, launchedAt: null, now })).toBe("foundation");
  });

  it("returns launch on launch day", () => {
    const launchDate = new Date("2026-05-15T00:00:00Z");
    expect(derivePhase({ state: "launching", launchDate, launchedAt: null, now })).toBe("launch");
  });

  it("returns momentum within 7 days of launch", () => {
    const launchDate = new Date("2026-05-20T00:00:00Z");
    expect(derivePhase({ state: "launching", launchDate, launchedAt: null, now })).toBe("momentum");
  });

  it("returns audience within 28 days of launch", () => {
    const launchDate = new Date("2026-06-05T00:00:00Z");
    expect(derivePhase({ state: "launching", launchDate, launchedAt: null, now })).toBe("audience");
  });
});
