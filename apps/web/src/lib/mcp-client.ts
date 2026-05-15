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
   * caller to navigate to (e.g. `/team/<id>`).
   *
   * The CMO tool serialises its return as a single JSON text block; we parse
   * it here so callers don't need to know the wire shape.
   */
  async startNewConversation(
    title?: string,
  ): Promise<{ conversationId: string }> {
    return this.callJsonTool<{ conversationId: string }>(
      "startNewConversation",
      title ? { title } : {},
    );
  }

  /**
   * List the founder's roster (every role ever hired, active + fired).
   *
   * Mirrors `queryRoster` in `apps/core/src/agents/cmo/tools/roster.ts`. The
   * client filters by status in the UI — we always pull the full set so
   * fired-then-rehired rows stay visible if we ever want to surface them.
   */
  async queryRoster(): Promise<
    Array<{
      role: string;
      hired_at: number;
      status: string;
      hire_config_json: string | null;
    }>
  > {
    return this.callJsonTool("queryRoster", {});
  }

  /**
   * List plan_items. Optionally filter by `status` / `ownerRole` and cap
   * `limit` (CMO clamps at 200).
   *
   * The type parameter `R` lets callers bind the row shape so they don't
   * need `as unknown as SomeType[]` at every use site:
   *
   *   const items = await client.queryPlanItems<PlanItem>({ limit: 50 });
   *
   * Defaults to `Record<string, unknown>` for backward-compat callers that
   * just render whatever columns arrive.
   */
  async queryPlanItems<R = Record<string, unknown>>(
    opts: { status?: string; ownerRole?: string; limit?: number } = {},
  ): Promise<R[]> {
    return this.callJsonTool<R[]>("queryPlanItems", opts);
  }

  /**
   * List active (non-archived) conversations, newest first. Used by the
   * `/team` page so founders can resume an old thread or start a new
   * one.
   */
  async listConversations(
    limit = 20,
  ): Promise<
    Array<{
      id: string;
      started_at: number;
      ended_at: number | null;
      title: string | null;
    }>
  > {
    return this.callJsonTool("listConversations", { limit });
  }

  /**
   * List drafts via CMO → SMM RPC. CMO's `queryDrafts` tool wraps SMM's
   * `list_drafts` and returns `[]` if SMM isn't hired yet (forward-compat
   * with cron ticks that run before the founder hires an SMM).
   *
   * The type parameter `R` lets callers bind the draft row shape:
   *
   *   const drafts = await client.queryDrafts<Draft>({ status: 'ready' });
   *
   * Defaults to `Record<string, unknown>` for callers that don't declare a
   * shape (e.g. the `/briefing` page which uses its own local `Draft` type).
   */
  async queryDrafts<R = Record<string, unknown>>(
    opts: { status?: string; limit?: number } = {},
  ): Promise<R[]> {
    return this.callJsonTool<R[]>("queryDrafts", opts);
  }

  /**
   * Approve a draft. Flips the matching `approval_queue` row to
   * `decision='approved'`. Throws if the draft isn't in the queue (e.g.
   * already approved, rejected, or never enqueued).
   */
  async approveDraft(
    draftId: string,
  ): Promise<{ draftId: string; decision: string }> {
    return this.callJsonTool("approveDraft", { draftId });
  }

  /**
   * Reject a draft. Flips the matching `approval_queue` row to
   * `decision='rejected'`. Throws if the draft isn't in the queue (e.g.
   * already decided, or never enqueued).
   *
   * `reason` is forwarded to the server but not persisted until
   * `approval_queue.reason` column lands (see shared-state.ts comment).
   */
  async rejectDraft(
    draftId: string,
    reason?: string,
  ): Promise<{ draftId: string; decision: "rejected" }> {
    return this.callJsonTool(
      "rejectDraft",
      reason !== undefined ? { draftId, reason } : { draftId },
    );
  }

  /**
   * Hire an employee role. Idempotent — re-hiring a fired role flips status
   * back to "active". CMO is implicit, so `hireEmployee("cmo")` is rejected
   * server-side.
   */
  async hireEmployee(
    role: string,
    hireConfig?: Record<string, unknown>,
  ): Promise<{ role: string; status: string }> {
    return this.callJsonTool(
      "hireEmployee",
      hireConfig ? { role, hireConfig } : { role },
    );
  }

  /**
   * Fire an employee. Status flips to "fired"; SQLite + history are preserved
   * so re-hiring restores the same DO instance.
   */
  async fireEmployee(
    role: string,
  ): Promise<{ role: string; status: string }> {
    return this.callJsonTool("fireEmployee", { role });
  }

  /**
   * P2-D — Save an opt-in long-term memory. The fact gets injected into every
   * future chat tool's system prompt regardless of conversationId. Founder
   * triggers this from the chat UI's "Remember" button on assistant turns.
   */
  async rememberThis(
    content: string,
    sourceConversationId?: string,
    sourceMessageTs?: number,
  ): Promise<{ id: string; ok: boolean }> {
    return this.callJsonTool("rememberThis", {
      content,
      sourceConversationId,
      sourceMessageTs,
    });
  }

  /**
   * P2-D — Soft-delete a memory entry (sets `active=0`; row preserved for
   * audit trail). Throws if the id doesn't exist.
   */
  async forgetThis(id: string): Promise<string> {
    if (!this.client) {
      throw new Error("CmoClient.forgetThis called before connect()");
    }
    const result = (await this.client.callTool({
      name: "forgetThis",
      arguments: { id },
    })) as CallToolResultLike;
    return extractText(result);
  }

  /**
   * P2-D — List active memories, newest first. Powers the `/memory` page.
   */
  async queryMemory(
    limit = 50,
  ): Promise<
    Array<{
      id: string;
      content: string;
      added_at: number;
      source_conversation_id: string | null;
    }>
  > {
    return this.callJsonTool("queryMemory", { limit });
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.transport = null;
  }

  /**
   * Generic helper for tools whose entire result is a single JSON text block.
   * The CMO server always returns `[{ type: "text", text: JSON.stringify(...) }]`
   * for non-streaming queries, so we concatenate every text block (defensive
   * against future multi-block returns) and `JSON.parse` once.
   *
   * Kept private so callers route through typed wrappers and we keep the
   * SDK shape contained.
   */
  private async callJsonTool<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    if (!this.client) {
      throw new Error(`CmoClient.${name} called before connect()`);
    }
    const result = (await this.client.callTool({
      name,
      arguments: args,
    })) as CallToolResultLike;
    const text = extractText(result);
    if (!text) return {} as T;
    return JSON.parse(text) as T;
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
