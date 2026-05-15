import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Spike #1: Anthropic streaming + tool use", () => {
  it("streams events and produces tool_use block", async () => {
    const res = await SELF.fetch("https://example.com/spike/01");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      eventCount: number;
      eventTypes: string[];
      stopReason: string;
      hasToolUse: boolean;
      toolName: string | null;
      toolUseId: string | null;
    };
    expect(body.eventCount).toBeGreaterThan(5);
    expect(body.eventTypes).toContain("content_block_delta");
    expect(body.stopReason).toBe("tool_use");
    expect(body.hasToolUse).toBe(true);
    expect(body.toolName).toBe("get_weather");
    expect(body.toolUseId).toMatch(/^toolu_/);
  }, 60_000);

  it("10 runs all succeed without silent fallback", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        SELF.fetch("https://example.com/spike/01").then((r) => r.json()),
      ),
    );
    for (const body of results as Array<{
      stopReason: string;
      hasToolUse: boolean;
    }>) {
      expect(body.stopReason).toBe("tool_use");
      expect(body.hasToolUse).toBe(true);
    }
  }, 300_000);
});
