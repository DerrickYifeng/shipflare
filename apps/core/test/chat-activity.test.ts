import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CMO } from "../src/agents/cmo/CMO";
import { applyCmoSchema } from "../src/agents/cmo/schema";

/**
 * Task 7 — `chat` tool emits `turn_start` / `turn_finish` activity events
 * with a shared synthetic `parentTurnId`. The web client groups child
 * events (delegations, tool calls) under the matching assistant bubble
 * using `_meta.parentTurnId` from the MCP tool result.
 *
 * Spec: 2026-05-15-agent-activity-feed-design.md §Task 7.
 *
 * Test approach (mirrors `get-recent-activity.test.ts`):
 *   - Non-transport DO names skip the parent McpAgent's onStart →
 *     applyCmoSchema bootstrap, so we run `applyCmoSchema` + `init()`
 *     ourselves inside `runInDurableObject`.
 *   - We invoke the tool's handler directly via `server._registeredTools`
 *     to avoid standing up an MCP transport for one assertion.
 *   - `.dev.vars` ships ANTHROPIC_API_KEY=empty in the test env, so the
 *     Anthropic call inside chat will fail. The `turn_finish` row is
 *     emitted with `status: 'error'` BEFORE the handler re-throws —
 *     that's the path we assert here. The success path is covered
 *     end-to-end when the founder hits Anthropic for real in dev.
 */

type RegisteredTool = {
  handler: (
    args: Record<string, unknown>,
    extra: Record<string, unknown>,
  ) => Promise<unknown>;
};

type ActivityRow = {
  kind: string;
  payload_json: string;
  parent_turn_id: string | null;
  conversation_id: string | null;
  source_agent: string;
  created_at: number;
};

describe("CMO chat tool — activity instrumentation", () => {
  it("emits turn_start + turn_finish with a shared parentTurnId (error path: no API key)", async () => {
    const stub = env.CMO.getByName("chat-activity-error-user");
    const conversationId = "conv-activity-err";

    await runInDurableObject(stub, async (instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
      await instance.init();

      // Seed the conversation row so the chat tool's INSERT into
      // founder_messages doesn't violate any future FK assumptions.
      state.storage.sql.exec(
        "INSERT INTO conversations (id, started_at) VALUES (?, ?)",
        conversationId,
        Date.now(),
      );

      const tools = (
        instance.server as unknown as {
          _registeredTools: Record<string, RegisteredTool>;
        }
      )._registeredTools;
      const chat = tools.chat;
      if (!chat) {
        throw new Error("chat tool not registered");
      }

      let threw = false;
      try {
        await chat.handler(
          { conversationId, message: "hi CMO" },
          { _meta: {} },
        );
      } catch {
        threw = true;
      }
      // With an empty ANTHROPIC_API_KEY the Anthropic call should fail
      // before `stream.finalMessage()` resolves — confirming we landed in
      // the error path.
      expect(threw).toBe(true);

      const rows = state.storage.sql
        .exec<ActivityRow>(
          `SELECT kind, payload_json, parent_turn_id, conversation_id, source_agent, created_at
           FROM activity_events
           WHERE conversation_id = ?
           ORDER BY created_at ASC`,
          conversationId,
        )
        .toArray();

      const kinds = rows.map((r) => r.kind);
      expect(kinds).toContain("turn_start");
      expect(kinds).toContain("turn_finish");

      // All events from this turn share one parent_turn_id (UUID), and
      // every row has it set (not null).
      const parentIds = new Set(rows.map((r) => r.parent_turn_id));
      expect(parentIds.size).toBe(1);
      const [parentTurnId] = [...parentIds];
      expect(parentTurnId).toMatch(/^[0-9a-f-]{36}$/);

      // turn_finish must surface status:'error' and a truncated errorMessage.
      const finish = rows.find((r) => r.kind === "turn_finish");
      expect(finish).toBeDefined();
      const payload = JSON.parse(finish!.payload_json) as {
        kind: string;
        status?: string;
        durationMs?: number;
        errorMessage?: string;
      };
      expect(payload.kind).toBe("turn_finish");
      expect(payload.status).toBe("error");
      expect(typeof payload.durationMs).toBe("number");
      expect(payload.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof payload.errorMessage).toBe("string");
      // Per spec the message is truncated to 200 chars.
      expect((payload.errorMessage ?? "").length).toBeLessThanOrEqual(200);

      // Source agent should be `cmo` for both events.
      for (const r of rows) {
        expect(r.source_agent).toBe("cmo");
      }
    });
  });
});
