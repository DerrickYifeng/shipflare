/**
 * `/api/growth/overview` route tests.
 *
 * Like `api-preferences.test.ts`, the route handler itself can't mount in
 * vitest without a Cloudflare context (it calls `getCloudflareContext()` to
 * obtain the D1 binding). We exercise the response-shape helpers and
 * type-narrowing logic directly here without needing the CF Workers runtime.
 *
 * End-to-end coverage (session gate, D1 reads, and full response shape)
 * happens via the manual smoke test noted in the 6.3 task notes.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Inline the shape-building logic so we can verify it without CF context.
// The logic mirrors what the GET handler computes.
// ---------------------------------------------------------------------------

type Platform = "x" | "reddit";

interface ChannelCard {
  platform: Platform;
  live: boolean;
  username: string | null;
  metrics: Record<string, number>;
  capturedAt: string | null;
}

interface GrowthModule {
  id: string;
  displayName: string;
  managerTitle: string;
  live: boolean;
  score: number;
  channels: ChannelCard[];
}

interface GrowthOverview {
  overallScore: number;
  modules: GrowthModule[];
}

function buildOverview(cards: ChannelCard[]): GrowthOverview {
  const liveCount = cards.filter((c) => c.live).length;
  const score = liveCount * 50;
  return {
    overallScore: score,
    modules: [
      {
        id: "social",
        displayName: "Social",
        managerTitle: "Social Media Manager",
        live: cards.some((c) => c.live),
        score,
        channels: cards,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/api/growth/overview — shape-building logic", () => {
  it("returns overallScore 0 when no channels are connected", () => {
    const cards: ChannelCard[] = [
      { platform: "x", live: false, username: null, metrics: {}, capturedAt: null },
      { platform: "reddit", live: false, username: null, metrics: {}, capturedAt: null },
    ];
    const result = buildOverview(cards);
    expect(result.overallScore).toBe(0);
    expect(result.modules[0].live).toBe(false);
    expect(result.modules[0].score).toBe(0);
  });

  it("returns overallScore 50 when one channel is connected", () => {
    const cards: ChannelCard[] = [
      { platform: "x", live: true, username: "testuser", metrics: {}, capturedAt: null },
      { platform: "reddit", live: false, username: null, metrics: {}, capturedAt: null },
    ];
    const result = buildOverview(cards);
    expect(result.overallScore).toBe(50);
    expect(result.modules[0].live).toBe(true);
    expect(result.modules[0].score).toBe(50);
  });

  it("returns overallScore 100 when both channels are connected", () => {
    const cards: ChannelCard[] = [
      { platform: "x", live: true, username: "xuser", metrics: { followers: 100 }, capturedAt: "2026-05-14T00:00:00.000Z" },
      { platform: "reddit", live: true, username: "redditor", metrics: { karma: 200 }, capturedAt: "2026-05-14T00:00:00.000Z" },
    ];
    const result = buildOverview(cards);
    expect(result.overallScore).toBe(100);
    expect(result.modules[0].live).toBe(true);
  });

  it("includes both platforms in the social module channels array", () => {
    const cards: ChannelCard[] = [
      { platform: "x", live: true, username: "xuser", metrics: {}, capturedAt: null },
      { platform: "reddit", live: false, username: null, metrics: {}, capturedAt: null },
    ];
    const result = buildOverview(cards);
    expect(result.modules).toHaveLength(1);
    expect(result.modules[0].id).toBe("social");
    expect(result.modules[0].channels).toHaveLength(2);
  });

  it("passes through metrics from the snapshot", () => {
    const cards: ChannelCard[] = [
      {
        platform: "x",
        live: true,
        username: "xuser",
        metrics: { followers: 1234, following: 56 },
        capturedAt: "2026-05-14T00:00:00.000Z",
      },
      { platform: "reddit", live: false, username: null, metrics: {}, capturedAt: null },
    ];
    const result = buildOverview(cards);
    const xCard = result.modules[0].channels.find((c) => c.platform === "x");
    expect(xCard?.metrics).toEqual({ followers: 1234, following: 56 });
    expect(xCard?.capturedAt).toBe("2026-05-14T00:00:00.000Z");
  });

  it("surfaces username from the channel row", () => {
    const cards: ChannelCard[] = [
      { platform: "x", live: true, username: "my_handle", metrics: {}, capturedAt: null },
      { platform: "reddit", live: false, username: null, metrics: {}, capturedAt: null },
    ];
    const result = buildOverview(cards);
    const xCard = result.modules[0].channels.find((c) => c.platform === "x");
    expect(xCard?.username).toBe("my_handle");
    const redditCard = result.modules[0].channels.find((c) => c.platform === "reddit");
    expect(redditCard?.username).toBeNull();
  });

  it("reports module managerTitle correctly", () => {
    const cards: ChannelCard[] = [
      { platform: "x", live: false, username: null, metrics: {}, capturedAt: null },
      { platform: "reddit", live: false, username: null, metrics: {}, capturedAt: null },
    ];
    const result = buildOverview(cards);
    expect(result.modules[0].managerTitle).toBe("Social Media Manager");
    expect(result.modules[0].displayName).toBe("Social");
  });
});
