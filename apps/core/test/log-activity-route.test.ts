import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import { transportName } from "../src/lib/do-name";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Tests for the CMO's `/internal/log-activity` ingest route — Task 4 of
 * spec 2026-05-15-agent-activity-feed-design.
 *
 * Cross-DO sub-agents (HoG, SMM, onboarding) fire-and-forget POST
 * `ActivityEventInput` payloads to this endpoint via Service Binding;
 * the CMO ingests them into its per-user `activity_events` table via
 * the single sanctioned writer (`emitActivity`).
 *
 * The endpoint is gated on `x-shipflare-internal: 1` (same pattern as
 * every other `/internal/*` route) — the public `fetch()` pre-check
 * returns 403 for missing-header requests before this handler runs.
 *
 * Bootstrap note: even with the `transportName()` (`streamable-http:`)
 * prefix, the parent McpAgent's `onStart` only fires when an MCP
 * transport session is initiated — driving the route via `stub.fetch`
 * skips that path, so we mirror the rest of the test suite and
 * re-apply `applyCmoSchema` via `runInDurableObject` before the SQL
 * write.
 */

async function bootstrap(stub: DurableObjectStub<CMO>): Promise<void> {
  await runInDurableObject(stub, async (_instance: CMO, state) => {
    applyCmoSchema(state.storage.sql);
  });
}

describe("CMO /internal/log-activity", () => {
  it("rejects requests without the internal header", async () => {
    const id = env.CMO.idFromName(transportName("user-test-A"));
    const stub = env.CMO.get(id);
    // No bootstrap needed — the 403 gate fires before the handler runs.
    const res = await stub.fetch("https://internal/internal/log-activity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: null,
        parentTurnId: null,
        runId: null,
        sourceAgent: "head-of-growth",
        parentEventId: null,
        kind: "turn_start",
        payload: { kind: "turn_start" },
      }),
    });
    expect(res.status).toBe(403);
  });

  it("accepts a valid event with the internal header and returns 204", async () => {
    const id = env.CMO.idFromName(transportName("user-test-B"));
    const stub = env.CMO.get(id);
    await bootstrap(stub);

    const res = await stub.fetch("https://internal/internal/log-activity", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shipflare-internal": "1",
      },
      body: JSON.stringify({
        conversationId: "c1",
        parentTurnId: null,
        runId: "r1",
        sourceAgent: "head-of-growth",
        parentEventId: null,
        kind: "turn_start",
        payload: { kind: "turn_start" },
      }),
    });
    expect(res.status).toBe(204);

    // The handler must route through `emitActivity` (the sanctioned
    // writer), which INSERTs into `activity_events` — verify the row
    // landed so a future refactor that bypasses the writer fails here.
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const rows = state.storage.sql
        .exec<{
          conversation_id: string | null;
          run_id: string | null;
          source_agent: string;
          kind: string;
        }>(
          "SELECT conversation_id, run_id, source_agent, kind FROM activity_events",
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        conversation_id: "c1",
        run_id: "r1",
        source_agent: "head-of-growth",
        kind: "turn_start",
      });
    });
  });

  it("rejects malformed events with 400", async () => {
    const id = env.CMO.idFromName(transportName("user-test-C"));
    const stub = env.CMO.get(id);
    // No bootstrap — schema validation rejects before SQL access.
    const res = await stub.fetch("https://internal/internal/log-activity", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shipflare-internal": "1",
      },
      body: JSON.stringify({ kind: "bogus" }),
    });
    expect(res.status).toBe(400);
  });
});
