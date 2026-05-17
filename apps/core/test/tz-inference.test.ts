import { describe, expect, it } from "vitest";
import { inferTimezone } from "../src/lib/tz-inference";

describe("inferTimezone", () => {
  it("prefers ?tz= query param when valid", () => {
    expect(inferTimezone("America/Los_Angeles", "Europe/Paris")).toBe(
      "America/Los_Angeles",
    );
  });

  it("falls back to request.cf.timezone when no query", () => {
    expect(inferTimezone(undefined, "Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("returns UTC when neither is provided", () => {
    expect(inferTimezone(undefined, undefined)).toBe("UTC");
  });

  it("rejects invalid IANA, falls through to next valid source", () => {
    expect(inferTimezone("not-a-tz", "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(inferTimezone("", "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(inferTimezone("xyz", "also-bad")).toBe("UTC");
  });

  it("validates query tz before accepting", () => {
    // garbage query, garbage cf, all fail → UTC
    expect(inferTimezone("/etc/passwd", "../../bad")).toBe("UTC");
  });
});
