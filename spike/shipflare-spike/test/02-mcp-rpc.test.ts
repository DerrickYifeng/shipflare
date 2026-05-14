import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Spike #2: McpAgent + addMcpServer RPC", () => {
  it("props pass through from agent to mcp tool handler", async () => {
    const res = await SELF.fetch("https://example.com/spike/02");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const first = body.result.content[0];
    expect(first).toBeTruthy();
    const toolResult = first ? first.text : "";
    const parsed = JSON.parse(toolResult) as {
      ping: string;
      propsUserId: string | null;
      propsSecret: string | null;
      callCount: number;
    };
    expect(parsed.ping).toBe("hello-rpc");
    expect(parsed.propsUserId).toBe("test-user-123");
    expect(parsed.propsSecret).toBe("test-secret-456");
  }, 30_000);

  it("call increments call count (state persists)", async () => {
    await SELF.fetch("https://example.com/spike/02");
    const res = await SELF.fetch("https://example.com/spike/02");
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const first = body.result.content[0];
    expect(first).toBeTruthy();
    const parsed = JSON.parse(first ? first.text : "") as {
      callCount: number;
    };
    expect(parsed.callCount).toBeGreaterThanOrEqual(2);
  }, 30_000);
});
