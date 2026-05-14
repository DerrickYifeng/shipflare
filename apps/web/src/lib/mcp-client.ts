/**
 * Browser-side MCP client wrapper for the CMO Durable Object's `/mcp` endpoint.
 *
 * Per spec D13, the browser talks to apps/core directly — the web Worker is
 * only used to issue short-lived JWTs via `/api/mcp-token`. This module wraps
 * the `@modelcontextprotocol/sdk` Client + StreamableHTTPClientTransport so
 * React components don't need to know the SDK shape.
 *
 * Lifecycle:
 *   1. `createCmoClient()` fetches a token from `/api/mcp-token` and returns
 *      a connected `CmoClient`.
 *   2. The component calls `chat(conversationId, message)` per founder turn.
 *   3. On unmount / page navigation, the component calls `close()` to release
 *      the transport. After close, the client is unusable — create a new one.
 *
 * Token refresh: the token is short-lived (60s) and is only used to initiate
 * the MCP handshake — once the SSE stream is established core does not re-
 * verify per request. If the connection drops, the caller should construct a
 * new client (and the SDK will refetch a token via `createCmoClient`).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpTokenResponse {
  /** Short-lived HS256 JWT signed by `/api/mcp-token` with `MCP_JWT_SECRET`. */
  token: string;
  /** Absolute URL of core's MCP endpoint, e.g. `https://core.example.com/agents/cmo/<userId>/mcp`. */
  mcpUrl: string;
}

interface ToolContentBlock {
  type: string;
  text?: string;
}

interface CallToolResultLike {
  content?: ToolContentBlock[] | unknown;
}

/**
 * Wraps a single MCP connection to the founder's CMO Durable Object.
 *
 * One instance per chat session. NOT a singleton — different conversation
 * IDs can share the same client, but unmounting the component should close
 * the transport so we don't leak SSE connections.
 */
export class CmoClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;

  async connect(tokenResponse: McpTokenResponse): Promise<void> {
    this.transport = new StreamableHTTPClientTransport(
      new URL(tokenResponse.mcpUrl),
      {
        requestInit: {
          headers: { authorization: `Bearer ${tokenResponse.token}` },
        },
      },
    );
    this.client = new Client({
      name: "shipflare-web",
      version: "1.0.0",
    });
    await this.client.connect(this.transport);
  }

  /**
   * Send a founder message to the CMO. Returns the full assistant reply.
   *
   * Phase 1 is request/response (no token streaming) — the chat tool returns
   * the entire reply in one MCP result. Phase 2 will upgrade to a streamable
   * tool (chunked SSE). The wrapper signature can stay synchronous-shaped
   * because callers already await the reply.
   */
  async chat(conversationId: string, message: string): Promise<string> {
    if (!this.client) {
      throw new Error("CmoClient.chat called before connect()");
    }
    const result = (await this.client.callTool({
      name: "chat",
      arguments: { conversationId, message },
    })) as CallToolResultLike;
    return extractText(result);
  }

  /**
   * Create a fresh conversation. Returns the new conversationId for the
   * caller to navigate to (e.g. `/chat/<id>`).
   *
   * The CMO tool serialises its return as a single JSON text block; we parse
   * it here so callers don't need to know the wire shape.
   */
  async startNewConversation(
    title?: string,
  ): Promise<{ conversationId: string }> {
    if (!this.client) {
      throw new Error("CmoClient.startNewConversation called before connect()");
    }
    const result = (await this.client.callTool({
      name: "startNewConversation",
      arguments: title ? { title } : {},
    })) as CallToolResultLike;
    const text = extractText(result) || "{}";
    return JSON.parse(text) as { conversationId: string };
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.transport = null;
  }
}

/**
 * Convenience constructor: fetch a token from `/api/mcp-token`, build a
 * `CmoClient`, connect, and return it. Throws if the user has no session
 * (the token route returns 401) or if the SSE handshake fails.
 *
 * The fetch is same-origin so Better Auth's session cookie rides along
 * automatically — no manual `credentials: "include"` needed for first-party
 * requests.
 */
export async function createCmoClient(): Promise<CmoClient> {
  const res = await fetch("/api/mcp-token");
  if (!res.ok) {
    throw new Error(
      `Failed to fetch MCP token: ${res.status} ${res.statusText}`,
    );
  }
  const tokenResponse = (await res.json()) as McpTokenResponse;
  const client = new CmoClient();
  await client.connect(tokenResponse);
  return client;
}

/**
 * Pull text content out of an MCP tool result. The SDK types `content` as
 * `unknown` at the call site, so we narrow defensively — any non-text block
 * is silently skipped (Phase 2 may add image / resource blocks).
 */
function extractText(result: CallToolResultLike): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is ToolContentBlock & { text: string } =>
        typeof c === "object" &&
        c !== null &&
        (c as ToolContentBlock).type === "text" &&
        typeof (c as ToolContentBlock).text === "string",
    )
    .map((c) => c.text)
    .join("\n");
}
