import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CMO } from "../src/agents/cmo/CMO";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import { transportName } from "../src/lib/do-name";

/**
 * Task 8 — `delegateToEmployee` emits `subagent_dispatch` BEFORE the
 * in-process MCP call and `subagent_finish` after it (both success and
 * error paths). The dispatch event's id is threaded into the inner
 * call's `args._trace.parentEventId` so child agents (HoG / SMM) can
 * nest their own events underneath.
 *
 * Spec: 2026-05-15-agent-activity-feed-design.md §Task 8.
 *
 * Test approach (mirrors `chat-activity.test.ts`):
 *   - Use `transportName(uid)` so the DO name matches what the real
 *     MCP transport would produce.
 *   - `applyCmoSchema` + `init()` inside `runInDurableObject` to
 *     bootstrap the SQLite tables that the parent McpAgent.onStart
 *     normally seeds.
 *   - Invoke the registered tool's handler directly via
 *     `server._registeredTools` — no MCP transport stand-up needed.
 *   - We deliberately do NOT hire HoG, so the lookup of the inner MCP
 *     server fails and the handler re-throws. The activity feed should
 *     still show the dispatch attempt AND a finish=error row.
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
  parent_event_id: string | null;
};

describe("CMO delegateToEmployee — activity instrumentation", () => {
  it("emits subagent_dispatch + subagent_finish (error path: HoG not hired)", async () => {
    const uid = "user-delegate-A";
    const conversationId = "conv-delegate-A";
    const stub = env.CMO.get(env.CMO.idFromName(transportName(uid)));

    await runInDurableObject(stub, async (instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
      await instance.init();

      const tools = (
        instance.server as unknown as {
          _registeredTools: Record<string, RegisteredTool>;
        }
      )._registeredTools;
      const delegate = tools.delegateToEmployee;
      if (!delegate) {
        throw new Error("delegateToEmployee tool not registered");
      }

      let threw = false;
      try {
        await delegate.handler(
          {
            role: "head-of-growth",
            tool: "noop",
            args: { message: "go figure out strategy" },
            conversationId,
          },
          { _meta: {} },
        );
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      const rows = state.storage.sql
        .exec<ActivityRow>(
          `SELECT kind, payload_json, parent_turn_id, conversation_id, source_agent, parent_event_id
           FROM activity_events
           WHERE conversation_id = ?
           ORDER BY created_at ASC`,
          conversationId,
        )
        .toArray();

      const kinds = rows.map((r) => r.kind);
      expect(kinds).toContain("subagent_dispatch");
      expect(kinds).toContain("subagent_finish");

      // All emits must be on the cmo source agent.
      for (const r of rows) {
        expect(r.source_agent).toBe("cmo");
      }

      // Dispatch event carries subAgent + promptPreview.
      const dispatch = rows.find((r) => r.kind === "subagent_dispatch");
      expect(dispatch).toBeDefined();
      const dispatchPayload = JSON.parse(dispatch!.payload_json) as {
        kind: string;
        subAgent: string;
        promptPreview?: string;
      };
      expect(dispatchPayload.kind).toBe("subagent_dispatch");
      expect(dispatchPayload.subAgent).toBe("head-of-growth");
      expect(typeof dispatchPayload.promptPreview).toBe("string");
      expect((dispatchPayload.promptPreview ?? "").length).toBeLessThanOrEqual(
        200,
      );

      // Finish event carries status='error', durationMs, and a truncated summary.
      const finish = rows.find((r) => r.kind === "subagent_finish");
      expect(finish).toBeDefined();
      const finishPayload = JSON.parse(finish!.payload_json) as {
        kind: string;
        subAgent: string;
        status: string;
        durationMs: number;
        summary?: string;
      };
      expect(finishPayload.kind).toBe("subagent_finish");
      expect(finishPayload.subAgent).toBe("head-of-growth");
      expect(finishPayload.status).toBe("error");
      expect(typeof finishPayload.durationMs).toBe("number");
      expect(finishPayload.durationMs).toBeGreaterThanOrEqual(0);
      expect((finishPayload.summary ?? "").length).toBeLessThanOrEqual(200);
    });
  });

  it("rejects unknown role before emitting anything", async () => {
    const uid = "user-delegate-B";
    const conversationId = "conv-delegate-B";
    const stub = env.CMO.get(env.CMO.idFromName(transportName(uid)));

    await runInDurableObject(stub, async (instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
      await instance.init();

      const tools = (
        instance.server as unknown as {
          _registeredTools: Record<string, RegisteredTool>;
        }
      )._registeredTools;
      const delegate = tools.delegateToEmployee;
      if (!delegate) {
        throw new Error("delegateToEmployee tool not registered");
      }

      let threw = false;
      try {
        await delegate.handler(
          {
            role: "not-a-real-role",
            tool: "noop",
            args: {},
            conversationId,
          },
          { _meta: {} },
        );
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      // Role validation runs BEFORE any activity emit — verify no rows.
      const rows = state.storage.sql
        .exec<ActivityRow>(
          `SELECT kind FROM activity_events WHERE conversation_id = ?`,
          conversationId,
        )
        .toArray();
      expect(rows.length).toBe(0);
    });
  });
});
