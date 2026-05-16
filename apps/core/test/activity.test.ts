import { describe, expect, it } from "vitest";
import {
  emitActivity,
  withTraceContext,
  currentTraceContext,
} from "../src/lib/activity";
import { applyCmoSchema } from "../src/agents/cmo/schema";

/**
 * Unit tests for `emitActivity` + the `AsyncLocalStorage`-based trace
 * context helpers (spec 2026-05-15-agent-activity-feed-design §5.1, §5.5).
 *
 * These tests intentionally use a structural fake of the CMO host
 * (`sqlStorage` + `broadcast`) rather than driving a real DO via
 * `runInDurableObject`. The writer's contract is "given any
 * `ActivityHost`-shaped object, INSERT a row and broadcast the event" —
 * the SqlStorage type is not exercised here, so we cast to `any` for the
 * fake. Real-DO end-to-end coverage lands in Task 8's integration test.
 */

function makeFakeAgent() {
  const rows: unknown[][] = [];
  const broadcasts: string[] = [];
  const fakeSql = {
    exec: (q: string, ...args: unknown[]) => {
      rows.push([q, ...args]);
      return { toArray: () => [] };
    },
  };
  // Exercise the schema bootstrap against the fake (no-op for our spy,
  // but proves the call still type-checks against the relaxed shape).
  applyCmoSchema(fakeSql as unknown as SqlStorage);
  return {
    rows,
    broadcasts,
    sqlStorage: fakeSql,
    broadcast: (m: string) => broadcasts.push(m),
  };
}

describe("emitActivity", () => {
  it("inserts a row and broadcasts the event", async () => {
    const agent = makeFakeAgent();
    await emitActivity(agent as never, {
      conversationId: "conv-1",
      parentTurnId: null,
      runId: null,
      sourceAgent: "cmo",
      parentEventId: null,
      kind: "turn_start",
      payload: { kind: "turn_start" },
    });

    const lastInsert = agent.rows.find(
      (r) =>
        typeof r[0] === "string" &&
        (r[0] as string).includes("INSERT INTO activity_events"),
    );
    expect(lastInsert).toBeDefined();

    expect(agent.broadcasts).toHaveLength(1);
    const broadcast = JSON.parse(agent.broadcasts[0]!);
    expect(broadcast.kind).toBe("turn_start");
    expect(broadcast.id).toMatch(/^[0-9a-f-]{36}$/); // UUID
    expect(typeof broadcast.createdAt).toBe("number");
    expect(broadcast.sourceAgent).toBe("cmo");
    expect(broadcast.payload).toEqual({ kind: "turn_start" });
  });
});

describe("trace context", () => {
  it("returns null outside a withTraceContext scope", () => {
    expect(currentTraceContext()).toBeNull();
  });

  it("returns the active context inside a scope", async () => {
    await withTraceContext(
      {
        runId: "r1",
        parentEventId: "p1",
        conversationId: "c1",
        parentTurnId: "t1",
      },
      async () => {
        expect(currentTraceContext()).toEqual({
          runId: "r1",
          parentEventId: "p1",
          conversationId: "c1",
          parentTurnId: "t1",
        });
      },
    );
  });
});
