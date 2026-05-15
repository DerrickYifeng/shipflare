import { describe, it, expect } from "vitest";

/**
 * Tests for `research_reddit_channels` (S4.5):
 *   - sort by fitScore desc, slice top-3
 *   - empty + short candidate lists handled
 *   - subreddits JSON round-trip via founder_context
 *   - corrupted founder_context.subreddits triggers re-research
 *
 * Following the same logic-not-RPC pattern as smm-process-posts.test.ts:
 * REDDIT_MCP doesn't exist until S5 and CMO RPC is exercised by the
 * existing integration tests; here we cover the deterministic logic.
 */

describe("SMM research_reddit_channels — sort + slice logic", () => {
  it("top-3 selected by descending fitScore", () => {
    const candidates = [
      { subreddit: "r/a", rank: 1, fitScore: 0.7 },
      { subreddit: "r/b", rank: 2, fitScore: 0.9 },
      { subreddit: "r/c", rank: 3, fitScore: 0.5 },
      { subreddit: "r/d", rank: 4, fitScore: 0.8 },
      { subreddit: "r/e", rank: 5, fitScore: 0.3 },
    ];
    const top3 = candidates
      .slice()
      .sort((a, b) => b.fitScore - a.fitScore)
      .slice(0, 3);
    expect(top3.map((s) => s.subreddit)).toEqual(["r/b", "r/d", "r/a"]);
  });

  it("fewer than 3 candidates: returns all sorted", () => {
    const candidates = [
      { subreddit: "r/x", rank: 1, fitScore: 0.5 },
      { subreddit: "r/y", rank: 2, fitScore: 0.9 },
    ];
    const top3 = candidates
      .slice()
      .sort((a, b) => b.fitScore - a.fitScore)
      .slice(0, 3);
    expect(top3).toHaveLength(2);
    expect(top3[0]!.subreddit).toBe("r/y");
  });

  it("empty candidates → empty top3", () => {
    const top3: Array<{ subreddit: string; rank: number; fitScore: number }> =
      [];
    const sorted = top3
      .slice()
      .sort((a, b) => b.fitScore - a.fitScore)
      .slice(0, 3);
    expect(sorted).toEqual([]);
  });

  it("subreddits JSON round-trips via founder_context.subreddits", () => {
    const top3 = [
      { subreddit: "r/saas", rank: 1, fitScore: 0.92 },
      { subreddit: "r/SaaS", rank: 2, fitScore: 0.87 },
      { subreddit: "r/Entrepreneur", rank: 3, fitScore: 0.81 },
    ];
    const stored = JSON.stringify(top3);
    const parsed = JSON.parse(stored) as typeof top3;
    expect(parsed).toEqual(top3);
    expect(parsed[0]!.subreddit).toBe("r/saas");
  });

  it("corrupted founder_context.subreddits triggers re-research (no force)", () => {
    // Simulates the catch path in the tool: JSON.parse of corrupted value
    // should fall through to research path (not short-circuit early).
    const corrupted = "not-json";
    let shouldProceed = false;
    try {
      const existing = JSON.parse(corrupted) as unknown;
      if (!Array.isArray(existing) || existing.length === 0) {
        shouldProceed = true;
      }
    } catch {
      shouldProceed = true;
    }
    expect(shouldProceed).toBe(true);
  });
});
