import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

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
    const body = await res.text();
    expect(body).toContain("jsonrpc");
    expect(body).toContain("result");
    // Streamable HTTP transport returns a session ID for subsequent requests.
    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
  }, 30_000);

  it("tools/list returns echo_props after initialize", async () => {
    // First initialize to get a session.
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

    // Send the initialized notification (no response expected).
    await postJsonRpc(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId!,
    );

    // Now list tools.
    const listRes = await postJsonRpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      },
      sessionId!,
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.text();
    expect(listBody).toContain("echo_props");
  }, 30_000);
});
