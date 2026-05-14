import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// Spike #6 — DO SQLite performance.
//
// Validates that DO SQLite hits acceptable per-row latency for ShipFlare's
// per-team state: SELECT p99 < 50ms, INSERT p99 < 5ms over a 10000-row table.

describe("Spike #6: DO SQLite performance", () => {
  it("10000 rows: select p99 < 50ms, insert p99 < 5ms", async () => {
    const res = await SELF.fetch("https://example.com/spike/06");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      seedMs: number;
      rowsInserted: number;
      select: { p50: number; p99: number; max: number };
      insert: { p50: number; p99: number; max: number };
    };
    expect(body.rowsInserted).toBe(10000);
    expect(body.select.p99).toBeLessThan(50);
    expect(body.insert.p99).toBeLessThan(5);
  }, 120_000);
});
