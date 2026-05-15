import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Spike #2: McpAgent + addMcpServer RPC", () => {
  it("props pass through from agent to mcp tool handler", async () => {
    const res = await SELF.fetch(
      "https://example.com/spike/02?name=test-props",
    );
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
    expect(parsed.callCount).toBe(1);
  }, 30_000);

  it("call increments call count (state persists)", async () => {
    // Use a unique agent name so this test gets a fresh DO; each AgentExample
    // namespaces its McpServerExample by `this.name`, so state is isolated
    // per parent agent.
    const name = "test-count";
    await SELF.fetch(`https://example.com/spike/02?name=${name}`);
    const res = await SELF.fetch(`https://example.com/spike/02?name=${name}`);
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const first = body.result.content[0];
    expect(first).toBeTruthy();
    const parsed = JSON.parse(first ? first.text : "") as {
      callCount: number;
    };
    expect(parsed.callCount).toBe(2);
  }, 30_000);
});
