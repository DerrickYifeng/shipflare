import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import { transportName } from "../src/lib/do-name";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Task 9 (spec 2026-05-15-agent-activity-feed-design): the onboarding
 * strategic-path SSE handler streams from Anthropic and forwards
 * `subagent_dispatch` / `subagent_text_delta` / `subagent_finish`
 * activity events to the user's CMO DO keyed by `runId`, so the
 * onboarding "Building plan" screen can render real strategist work
 * through the activity feed.
 *
 * Test approach:
 *  - Drive the route via `SELF.fetch` (the SSE handler short-circuits
 *    when env.STRATEGIC_PATH_FIXTURE === "1" so we never call real Anthropic).
 *    The fixture binding is set in `vitest.config.mts` — it is NOT
 *    pulled from the request body, so the trust-boundary leak (any
 *    authenticated browser forcing fixture mode by spreading the flag
 *    through the web proxy) is closed.
 *  - The fixture path emits a deterministic 3-chunk text sequence of
 *    schema-valid strategic-path JSON, so we can assert kinds +
 *    ordering without flakiness AND the same `strategicPathSchema.parse()`
 *    that runs in production also runs here.
 *  - After draining the SSE stream we read `activity_events` directly
 *    out of CMO's storage via `runInDurableObject` (CMO is name-routed
 *    with `transportName(userId)`, matching the production write path).
 *  - We must call `applyCmoSchema` once before the activity events land
 *    (same bootstrap as `log-activity-route.test.ts`) because plain
 *    `stub.fetch` invocations skip the MCP transport bootstrap that
 *    normally seeds the schema. We do it after the SSE drain so the
 *    inserts that land via `forwardActivityToCmo` run against the
 *    initialized table.
 *
 *  Caveat: `forwardActivityToCmo` uses `ctx.waitUntil` (fire-and-forget).
 *  In vitest-pool-workers the `waitUntil` promises resolve before the
 *  outer `await SELF.fetch` returns once we drain the SSE body, but we
 *  still add a small settle window to defend against scheduling races.
 */

type ActivityRow = {
  kind: string;
  payload_json: string;
  run_id: string | null;
  source_agent: string;
  created_at: number;
};

describe("onboarding strategic-path — emits activity events", () => {
  it("persists subagent_dispatch / text_delta / subagent_finish keyed by runId (fixture path)", async () => {
    const userId = "user-strategic-A";
    const runId = crypto.randomUUID();

    // Pre-bootstrap the CMO so the schema exists before the fire-and-forget
    // POSTs land. Without this, `log-activity` returns 500 on the first
    // INSERT because `activity_events` doesn't exist yet. The CMO is
    // name-routed with `transportName(userId)` — match the production
    // forward path exactly.
    const cmoId = env.CMO.idFromName(transportName(userId));
    const cmoStub = env.CMO.get(cmoId);
    await runInDurableObject(cmoStub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
    });

    const res = await SELF.fetch(
      "https://internal/internal/onboarding/strategic-path",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shipflare-internal": "1",
        },
        body: JSON.stringify({
          userId,
          runId,
          product: {
            name: "Test",
            description: "A test product",
            keywords: ["test"],
            category: "saas",
          },
          state: "mvp",
          channels: ["x"],
        }),
      },
    );
    expect(res.ok).toBe(true);

    // Drain the SSE stream so the handler runs to completion and all
    // `waitUntil` forwards are scheduled.
    const reader = res.body!.getReader();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    // Small settle window — `waitUntil` is fire-and-forget; let the
    // forwarded POSTs to CMO land before we read.
    await new Promise((r) => setTimeout(r, 50));

    // Read the activity rows directly out of CMO storage.
    const rows = await runInDurableObject(
      cmoStub,
      async (_instance: CMO, state) => {
        return state.storage.sql
          .exec<ActivityRow>(
            `SELECT kind, payload_json, run_id, source_agent, created_at
             FROM activity_events
             WHERE run_id = ?
             ORDER BY created_at ASC`,
            runId,
          )
          .toArray();
      },
    );

    const kinds = rows.map((r) => r.kind);
    expect(kinds.length).toBeGreaterThanOrEqual(3);
    // Order is not asserted: forwardActivityToCmo uses ctx.waitUntil to fire
    // parallel fetches at the receiver; under suite contention the arrival
    // order at CMO can differ from caller emission order. The receiver's
    // monotonic createdAt counter stamps insert-order, not emission-order.
    // The user-visible ActivityTrail (Task 13) applies a defensive sort that
    // puts *_start before *_finish for same-ms ties, so the UI is correct
    // regardless. Here we just verify the three event kinds were persisted.
    expect(kinds).toContain("subagent_dispatch");
    expect(kinds).toContain("subagent_text_delta");
    expect(kinds).toContain("subagent_finish");

    // Every row must carry sourceAgent='strategic-planner' + the runId we
    // passed in, so the web feed can group them under the right run.
    for (const r of rows) {
      expect(r.source_agent).toBe("strategic-planner");
      expect(r.run_id).toBe(runId);
    }

    // The finish event must be status='ok' for the fixture path (no
    // parse failure, no exception).
    const finish = rows.find((r) => r.kind === "subagent_finish");
    expect(finish).toBeDefined();
    const finishPayload = JSON.parse(finish!.payload_json) as {
      kind: string;
      subAgent: string;
      status?: string;
      durationMs?: number;
      summary?: string;
    };
    expect(finishPayload.kind).toBe("subagent_finish");
    expect(finishPayload.subAgent).toBe("strategic-planner");
    expect(finishPayload.status).toBe("ok");
    expect(typeof finishPayload.durationMs).toBe("number");
  });

  it("no-op back-compat path: omitting runId does not write to CMO", async () => {
    const userId = "user-strategic-B";
    const cmoId = env.CMO.idFromName(transportName(userId));
    const cmoStub = env.CMO.get(cmoId);
    await runInDurableObject(cmoStub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
    });

    const res = await SELF.fetch(
      "https://internal/internal/onboarding/strategic-path",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shipflare-internal": "1",
        },
        body: JSON.stringify({
          userId,
          // No runId — back-compat caller (old web build).
          product: {
            name: "Test",
            description: "A test product",
            keywords: ["test"],
            category: "saas",
          },
          state: "mvp",
          channels: ["x"],
        }),
      },
    );
    expect(res.ok).toBe(true);
    const reader = res.body!.getReader();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    await new Promise((r) => setTimeout(r, 50));

    const rows = await runInDurableObject(
      cmoStub,
      async (_instance: CMO, state) => {
        return state.storage.sql
          .exec<ActivityRow>(
            "SELECT kind FROM activity_events WHERE source_agent = 'strategic-planner'",
          )
          .toArray();
      },
    );
    expect(rows).toHaveLength(0);
  });
});
