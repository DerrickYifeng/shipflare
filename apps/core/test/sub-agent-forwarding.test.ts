import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { transportName } from "../src/lib/do-name";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import {
  extractTrace,
  withSubAgentToolTracing,
} from "../src/lib/subagent-activity";
import type { Env } from "../src/index";

/**
 * Task 10 — sub-agent activity forwarding helper.
 *
 * `withSubAgentToolTracing` is the wrapper sub-agent tools (HoG / SMM)
 * use to bracket their work with `subagent_tool_call_start` /
 * `subagent_tool_call_finish` events. The events land in the CMO's
 * `activity_events` table via the existing `forwardActivityToCmo`
 * service-binding POST.
 *
 * We exercise the helper directly rather than driving CMO →
 * delegate-to-HoG → in-process MCP → HoG-ping, because the MCP
 * transport setup (which seeds `props.userId`) doesn't fire for
 * non-transport-named DOs in vitest. The ping tool registrations on
 * HoG/SMM exist as production integration glue — their behavior is
 * identical to calling the helper directly, which is what we test
 * here.
 */

type ActivityRow = {
  kind: string;
  source_agent: string;
  payload_json: string;
};

describe("extractTrace", () => {
  it("returns null when args is null/undefined/non-object", () => {
    expect(extractTrace(undefined)).toBeNull();
    expect(extractTrace(null)).toBeNull();
    expect(extractTrace(42)).toBeNull();
    expect(extractTrace("nope")).toBeNull();
  });

  it("returns null when _trace is missing or non-object", () => {
    expect(extractTrace({})).toBeNull();
    expect(extractTrace({ _trace: null })).toBeNull();
    expect(extractTrace({ _trace: "not-an-object" })).toBeNull();
  });

  it("returns null when _trace lacks a string userId", () => {
    expect(extractTrace({ _trace: {} })).toBeNull();
    expect(extractTrace({ _trace: { userId: 1 } })).toBeNull();
  });

  it("returns a normalized trace with optional fields defaulting to null", () => {
    expect(extractTrace({ _trace: { userId: "u" } })).toEqual({
      userId: "u",
      runId: null,
      parentEventId: null,
      conversationId: null,
      parentTurnId: null,
    });
  });

  it("passes through populated optional fields", () => {
    expect(
      extractTrace({
        _trace: {
          userId: "u",
          runId: "r",
          parentEventId: "p",
          conversationId: "c",
          parentTurnId: "t",
        },
      }),
    ).toEqual({
      userId: "u",
      runId: "r",
      parentEventId: "p",
      conversationId: "c",
      parentTurnId: "t",
    });
  });
});

describe("withSubAgentToolTracing", () => {
  it("is a no-op when trace is null", async () => {
    const ctx = { waitUntil: (): void => undefined };
    const out = await withSubAgentToolTracing(
      ctx,
      env as unknown as Env,
      null,
      "head-of-growth",
      "ping",
      {},
      async () => "ran",
    );
    expect(out).toBe("ran");
  });

  it("forwards start + finish events to CMO on success", async () => {
    const uid = "user-sub-A";
    const conv = "conv-sub-A";
    const stub = env.CMO.get(env.CMO.idFromName(transportName(uid)));
    await runInDurableObject(stub, async (_instance, state) => {
      applyCmoSchema(state.storage.sql);
    });

    const trace = {
      userId: uid,
      runId: "r-1",
      parentEventId: "p-1",
      conversationId: conv,
      parentTurnId: null,
    };
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>): void => {
        pending.push(p);
      },
    };

    const out = await withSubAgentToolTracing(
      ctx,
      env as unknown as Env,
      trace,
      "head-of-growth",
      "ping",
      { ping: true },
      async () => "pong",
    );
    expect(out).toBe("pong");
    await Promise.all(pending);

    await runInDurableObject(stub, async (_instance, state) => {
      const rows = state.storage.sql
        .exec<ActivityRow>(
          `SELECT kind, source_agent, payload_json
             FROM activity_events
            WHERE conversation_id = ?
            ORDER BY created_at ASC`,
          conv,
        )
        .toArray();
      const kinds = rows.map((r) => r.kind);
      expect(kinds).toContain("subagent_tool_call_start");
      expect(kinds).toContain("subagent_tool_call_finish");

      const startRow = rows.find(
        (r) => r.kind === "subagent_tool_call_start",
      );
      expect(startRow).toBeDefined();
      expect(startRow!.source_agent).toBe("head-of-growth");
      const startPayload = JSON.parse(startRow!.payload_json) as {
        kind: string;
        subAgent: string;
        tool: string;
        argsPreview?: string;
      };
      expect(startPayload.kind).toBe("subagent_tool_call_start");
      expect(startPayload.subAgent).toBe("head-of-growth");
      expect(startPayload.tool).toBe("ping");
      expect((startPayload.argsPreview ?? "").length).toBeLessThanOrEqual(200);

      const finishRow = rows.find(
        (r) => r.kind === "subagent_tool_call_finish",
      );
      expect(finishRow).toBeDefined();
      const finishPayload = JSON.parse(finishRow!.payload_json) as {
        kind: string;
        subAgent: string;
        tool: string;
        status: string;
        durationMs: number;
      };
      expect(finishPayload.status).toBe("ok");
      expect(finishPayload.tool).toBe("ping");
      expect(finishPayload.subAgent).toBe("head-of-growth");
      expect(finishPayload.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  it("emits status='error' when the body throws and re-throws", async () => {
    const uid = "user-sub-B";
    const conv = "conv-sub-B";
    const stub = env.CMO.get(env.CMO.idFromName(transportName(uid)));
    await runInDurableObject(stub, async (_instance, state) => {
      applyCmoSchema(state.storage.sql);
    });
    const trace = {
      userId: uid,
      runId: "r-2",
      parentEventId: "p-2",
      conversationId: conv,
      parentTurnId: null,
    };
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>): void => {
        pending.push(p);
      },
    };

    await expect(
      withSubAgentToolTracing(
        ctx,
        env as unknown as Env,
        trace,
        "head-of-growth",
        "ping",
        {},
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    await Promise.all(pending);

    await runInDurableObject(stub, async (_instance, state) => {
      const rows = state.storage.sql
        .exec<ActivityRow>(
          `SELECT kind, source_agent, payload_json
             FROM activity_events
            WHERE conversation_id = ?
            ORDER BY created_at ASC`,
          conv,
        )
        .toArray();
      const finish = rows.find((r) => r.kind === "subagent_tool_call_finish");
      expect(finish).toBeDefined();
      const payload = JSON.parse(finish!.payload_json) as {
        status: string;
        tool: string;
      };
      expect(payload.status).toBe("error");
      expect(payload.tool).toBe("ping");
    });
  });

  it("uses the supplied subAgent label (works for SMM as well as HoG)", async () => {
    const uid = "user-sub-C";
    const conv = "conv-sub-C";
    const stub = env.CMO.get(env.CMO.idFromName(transportName(uid)));
    await runInDurableObject(stub, async (_instance, state) => {
      applyCmoSchema(state.storage.sql);
    });
    const trace = {
      userId: uid,
      runId: "r-3",
      parentEventId: "p-3",
      conversationId: conv,
      parentTurnId: null,
    };
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>): void => {
        pending.push(p);
      },
    };

    await withSubAgentToolTracing(
      ctx,
      env as unknown as Env,
      trace,
      "social-media-manager",
      "ping",
      {},
      async () => "ok",
    );
    await Promise.all(pending);

    await runInDurableObject(stub, async (_instance, state) => {
      const rows = state.storage.sql
        .exec<ActivityRow>(
          `SELECT kind, source_agent, payload_json
             FROM activity_events
            WHERE conversation_id = ?
            ORDER BY created_at ASC`,
          conv,
        )
        .toArray();
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const r of rows) {
        expect(r.source_agent).toBe("social-media-manager");
      }
    });
  });
});
