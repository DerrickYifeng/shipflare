import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import { emitActivity } from "../src/lib/activity";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Tests for the CMO's `getRecentActivity` MCP tool — Task 5 of spec
 * 2026-05-15-agent-activity-feed-design.
 *
 * The web client calls this tool on mount + after WS reconnect to seed
 * the activity feed before the live stream takes over. Pass `sinceMs`
 * (the last-seen `createdAt`) on reconnect to avoid re-fetching rows
 * the client already has.
 *
 * Test approach (matches the rest of the CMO suite):
 *  - Non-transport DO names skip the parent McpAgent's transport init,
 *    which also skips `onStart`'s schema bootstrap. We re-apply
 *    `applyCmoSchema` via `runInDurableObject` and explicitly call
 *    `init()` so the tool gets registered against `instance.server`.
 *  - We invoke the registered tool's `handler` directly out of
 *    `server._registeredTools` (a private member of @modelcontextprotocol
 *    /sdk's McpServer — `tool.handler(args, extra)` is the same path
 *    `executeToolHandler` uses inside the SDK's CallToolRequestSchema
 *    dispatcher) rather than driving a JSON-RPC round trip through the
 *    transport. This keeps the test fast + deterministic without
 *    standing up a fake transport.
 *  - Activity rows are inserted via `emitActivity` (the sanctioned
 *    writer) so we exercise the same code path production uses.
 */

/**
 * Shape of an entry in McpServer's private `_registeredTools` map. The
 * SDK calls `tool.handler(args, extra)` from its CallToolRequestSchema
 * dispatcher (node_modules/.../server/mcp.js → executeToolHandler) —
 * we do the same here. The `extra` arg is loosely typed; we pass an
 * empty object because `getRecentActivity` doesn't read from it.
 */
type RegisteredTool = {
  handler: (
    args: Record<string, unknown>,
    extra: Record<string, unknown>,
  ) => Promise<unknown>;
};

async function setupAndInvoke(
  userId: string,
  events: Array<Parameters<typeof emitActivity>[1]>,
  args: Record<string, unknown>,
): Promise<{
  status: number;
  result?: unknown;
  errorMessage?: string;
}> {
  const stub = env.CMO.getByName(userId);
  return runInDurableObject(stub, async (instance: CMO, state) => {
    applyCmoSchema(state.storage.sql);
    // McpAgent guards init() with `_toolsRegistered` so it's safe to call
    // here even though parent onStart() may also call it on a real
    // transport session.
    await instance.init();
    for (const evt of events) {
      await emitActivity(instance, evt);
    }

    // Pull the tool's callback out of the McpServer's private registry.
    // The SDK exposes it as `_registeredTools` (see node_modules
    // /@modelcontextprotocol/sdk/.../server/mcp.js:649 — same field the
    // SDK reads from its CallToolRequestSchema handler).
    const tools = (
      instance.server as unknown as {
        _registeredTools: Record<string, RegisteredTool>;
      }
    )._registeredTools;
    const tool = tools.getRecentActivity;
    if (!tool) {
      return { status: 404, errorMessage: "tool not registered" };
    }
    try {
      const result = await tool.handler(args, {});
      return { status: 200, result };
    } catch (err) {
      return {
        status: 500,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
};

function extractRows(result: unknown): Array<Record<string, unknown>> {
  const r = result as ToolTextResult;
  const block = r.content[0];
  if (!block) {
    throw new Error("tool returned empty content array");
  }
  return JSON.parse(block.text) as Array<Record<string, unknown>>;
}

describe("CMO getRecentActivity tool", () => {
  it("returns events for a given runId, oldest first", async () => {
    const { status, result } = await setupAndInvoke(
      "user-recent-A",
      [
        {
          conversationId: null,
          parentTurnId: null,
          runId: "r-1",
          sourceAgent: "head-of-growth",
          parentEventId: null,
          kind: "turn_start",
          payload: { kind: "turn_start" },
        },
        {
          conversationId: null,
          parentTurnId: null,
          runId: "r-1",
          sourceAgent: "head-of-growth",
          parentEventId: null,
          kind: "turn_finish",
          payload: { kind: "turn_finish", status: "ok", durationMs: 100 },
        },
      ],
      { runId: "r-1" },
    );

    expect(status).toBe(200);
    const rows = extractRows(result);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe("turn_start");
    expect(rows[1]?.kind).toBe("turn_finish");
    // Sanity: snake_case columns surfaced as camelCase per ActivityEvent shape.
    expect(rows[0]?.sourceAgent).toBe("head-of-growth");
    expect(rows[0]?.runId).toBe("r-1");
    expect(rows[0]?.createdAt).toEqual(expect.any(Number));
  });

  it("filters by conversationId when only conversationId is given", async () => {
    const { status, result } = await setupAndInvoke(
      "user-recent-conv",
      [
        {
          conversationId: "conv-A",
          parentTurnId: null,
          runId: null,
          sourceAgent: "head-of-growth",
          parentEventId: null,
          kind: "turn_start",
          payload: { kind: "turn_start" },
        },
        {
          conversationId: "conv-B",
          parentTurnId: null,
          runId: null,
          sourceAgent: "head-of-growth",
          parentEventId: null,
          kind: "turn_start",
          payload: { kind: "turn_start" },
        },
      ],
      { conversationId: "conv-A" },
    );

    expect(status).toBe(200);
    const rows = extractRows(result);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.conversationId).toBe("conv-A");
  });

  it("respects sinceMs by excluding rows with createdAt <= sinceMs", async () => {
    const stub = env.CMO.getByName("user-recent-since");
    // First write one event, capture its createdAt, then write another.
    const firstAt = await runInDurableObject(
      stub,
      async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        await instance.init();
        await emitActivity(instance, {
          conversationId: null,
          parentTurnId: null,
          runId: "r-since",
          sourceAgent: "head-of-growth",
          parentEventId: null,
          kind: "turn_start",
          payload: { kind: "turn_start" },
        });
        const row = state.storage.sql
          .exec<{ created_at: number }>(
            "SELECT created_at FROM activity_events ORDER BY created_at ASC LIMIT 1",
          )
          .one();
        return row.created_at;
      },
    );

    // Ensure the second event lands strictly after `firstAt` even on
    // fast machines where Date.now() can collide.
    await new Promise((r) => setTimeout(r, 5));

    const { status, result } = await runInDurableObject(
      stub,
      async (instance: CMO) => {
        await emitActivity(instance, {
          conversationId: null,
          parentTurnId: null,
          runId: "r-since",
          sourceAgent: "head-of-growth",
          parentEventId: null,
          kind: "turn_finish",
          payload: { kind: "turn_finish", status: "ok", durationMs: 1 },
        });
        const tools = (
          instance.server as unknown as {
            _registeredTools: Record<string, RegisteredTool>;
          }
        )._registeredTools;
        const tool = tools.getRecentActivity;
        if (!tool) {
          throw new Error("getRecentActivity tool not registered");
        }
        const r = await tool.handler(
          { runId: "r-since", sinceMs: firstAt },
          {},
        );
        return { status: 200, result: r };
      },
    );

    expect(status).toBe(200);
    const rows = extractRows(result);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("turn_finish");
  });

  it("errors when neither conversationId nor runId is given", async () => {
    const { status, errorMessage } = await setupAndInvoke(
      "user-recent-B",
      [],
      {},
    );
    expect(status).toBe(500);
    expect(errorMessage ?? "").toMatch(/conversationId or runId required/);
  });
});
