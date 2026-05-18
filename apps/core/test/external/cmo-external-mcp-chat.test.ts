import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { applyCmoSchema } from "../../src/agents/cmo/schema";
import type { CmoExternalMcp } from "../../src/external/CmoExternalMcp";
import type { CMO } from "../../src/agents/cmo/CMO";

/**
 * Address the external-MCP DO via the `rpc:` naming scheme so McpAgent
 * selects the in-process RPCServerTransport. That lets the test call
 * `stub.handleMcpMessage(...)` directly — no Streamable HTTP / SSE plumbing,
 * no upstream URL routing, just JSON-RPC in / JSON-RPC out. The OAuth
 * provider wrapper in 7.3 fronts the streamable-http variant for real
 * external clients; the DO itself is transport-agnostic.
 */
function getRpcStub(userId: string) {
  return env.CMO_EXTERNAL_MCP.get(
    env.CMO_EXTERNAL_MCP.idFromName(`rpc:${userId}`),
  );
}

type McpRpcStub = {
  handleMcpMessage: (
    message: unknown,
  ) => Promise<{ result?: unknown; error?: unknown } | undefined>;
};

async function initializeMcp(stub: unknown): Promise<void> {
  // MCP transports require an initialize handshake before tools/list or
  // tools/call. We send one synthetic initialize so the server populates
  // its protocol-version metadata.
  await (stub as McpRpcStub).handleMcpMessage({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0.0.0" },
    },
  });
}

describe("CmoExternalMcp", () => {
  it("registers exactly one tool: chat", async () => {
    const stub = getRpcStub("ext-mcp-1");
    await initializeMcp(stub);

    const res = (await (stub as unknown as McpRpcStub).handleMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    })) as { result?: { tools?: Array<{ name: string }> } } | undefined;

    const tools = res?.result?.tools ?? [];
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["chat"]);
  });

  it("chat tool forwards to internal CMO via invokeAsTool (dry-run)", async () => {
    const userId = "ext-mcp-2";

    // Bootstrap the real CMO + dry-run reply
    const cmoStub = env.CMO.getByName(`streamable-http:${userId}`);
    await runInDurableObject<CMO, void>(cmoStub, async (_inst, state) => {
      applyCmoSchema(state.storage.sql);
      state.storage.sql.exec(
        "INSERT INTO founder_context (key, value) VALUES (?, ?)",
        "productName",
        "TestProd",
      );
    });
    await runInDurableObject<CMO, void>(cmoStub, async (instance) => {
      (instance as unknown as { _invokeAsToolDryRun?: string })._invokeAsToolDryRun =
        "Hello from CMO";
    });

    // Wake the external MCP DO and inject test props, then invoke the chat tool.
    const extStub = getRpcStub(userId);
    await initializeMcp(extStub);
    await runInDurableObject<CmoExternalMcp, void>(extStub, async (instance) => {
      (
        instance as unknown as {
          _testProps?: { userId: string; scopes: string[] };
        }
      )._testProps = { userId, scopes: ["cmo:chat"] };
    });

    const res = (await (extStub as unknown as McpRpcStub).handleMcpMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "chat", arguments: { message: "How was today?" } },
    })) as
      | { result?: { content?: Array<{ type: string; text: string }> } }
      | undefined;

    const content = res?.result?.content ?? [];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("Hello from CMO");
  });
});
