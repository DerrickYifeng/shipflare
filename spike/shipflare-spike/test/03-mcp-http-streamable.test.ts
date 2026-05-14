import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

function parseSseMessage(body: string): JsonRpcResponse {
  const dataLine = body.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) {
    throw new Error("no SSE data line in response: " + body.slice(0, 200));
  }
  return JSON.parse(dataLine.slice(5).trim()) as JsonRpcResponse;
}

async function postJsonRpc(body: object, sessionId?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return SELF.fetch("https://example.com/external-mcp/test-user/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("Spike #3: MCP Streamable HTTP external", () => {
  it("initialize handshake returns valid JSON-RPC + session header", async () => {
    const res = await postJsonRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "spike-test-client", version: "1.0.0" },
      },
    });
    expect(res.status).toBe(200);
    const json = parseSseMessage(await res.text());
    expect(json.jsonrpc).toBe("2.0");
    expect(json.error).toBeUndefined();
    expect(json.result).toBeDefined();
    // Session id format check (also serves as regression guard if SDK
    // changes format — observed in agents@0.12.4 as a 64-char lowercase hex).
    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it("tools/list returns echo_props after initialize", async () => {
    const initRes = await postJsonRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "spike-test-client", version: "1.0.0" },
      },
    });
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    // Initialized notification — fire-and-forget, no body.
    await postJsonRpc(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId!,
    );

    const listRes = await postJsonRpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      },
      sessionId!,
    );
    expect(listRes.status).toBe(200);
    const json = parseSseMessage(await listRes.text());
    expect(json.error).toBeUndefined();
    const tools = (json.result as { tools: Array<{ name: string }> }).tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.find((t) => t.name === "echo_props")).toBeDefined();
  }, 30_000);
});
