import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import { logPeerDmShadow } from "../src/lib/peer-dm-shadow";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Tests for the shared `logPeerDmShadow` helper — P2-C.
 *
 * The helper hits CMO's `/internal/peer-dm-shadow` route, which is also
 * exercised by `cmo-internal.test.ts`. These tests focus on the caller-side
 * contract: a successful POST appends a row with `kind='peer_dm_shadow'`
 * and `notified_founder=0`, and multiple shadows accumulate.
 *
 * Spec §6.1 invariant #2 is enforced by the route (it only writes SQL and
 * does not invoke any LLM / chat machinery); we verify the row shape here.
 *
 * Schema bootstrap follows the same pattern as `cmo-internal.test.ts` —
 * non-transport DO names skip the parent McpAgent transport init and our
 * `onStart` schema bootstrap, so we re-apply `applyCmoSchema` via
 * `runInDurableObject` before driving SQL.
 */

async function bootstrap(stub: DurableObjectStub<CMO>): Promise<void> {
  await runInDurableObject(stub, async (_instance: CMO, state) => {
    applyCmoSchema(state.storage.sql);
  });
}

describe("logPeerDmShadow", () => {
  it("writes an employee_log row with kind='peer_dm_shadow' and notified_founder=0", async () => {
    const userId = "peer-dm-test-user-1";
    // logPeerDmShadow looks up the CMO by `transportName(userId)`
    // (`streamable-http:<id>`); bootstrap the same DO instance.
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await bootstrap(stub);

    await logPeerDmShadow(env.CMO, userId, {
      conversationId: "conv-1",
      fromRole: "social-media-manager",
      toRole: "head-of-growth",
      tool: "audit_plan",
      summary: "SMM asked HoG to audit",
      payload: { originalLength: 280, rewrittenLength: 260 },
    });

    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const rows = state.storage.sql
        .exec<{
          kind: string;
          from_role: string;
          summary: string;
          payload_json: string;
          conversation_id: string | null;
          notified_founder: number;
        }>(
          "SELECT kind, from_role, summary, payload_json, conversation_id, notified_founder FROM employee_log",
        )
        .toArray();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error("expected 1 row, got 0");
      expect(row).toMatchObject({
        kind: "peer_dm_shadow",
        from_role: "social-media-manager",
        notified_founder: 0,
        conversation_id: "conv-1",
        summary: "SMM asked HoG to audit",
      });
      const payload = JSON.parse(row.payload_json) as {
        to: string;
        tool: string;
        payload: { originalLength: number; rewrittenLength: number };
      };
      expect(payload).toMatchObject({
        to: "head-of-growth",
        tool: "audit_plan",
        payload: { originalLength: 280, rewrittenLength: 260 },
      });
    });
  });

  it("multiple shadows accumulate in employee_log", async () => {
    const userId = "peer-dm-test-user-2";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await bootstrap(stub);

    for (let i = 0; i < 3; i++) {
      await logPeerDmShadow(env.CMO, userId, {
        fromRole: "social-media-manager",
        toRole: "head-of-growth",
        tool: "audit_plan",
        summary: `shadow ${i}`,
      });
    }

    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const count = state.storage.sql
        .exec<{ c: number }>(
          "SELECT COUNT(*) as c FROM employee_log WHERE kind = 'peer_dm_shadow'",
        )
        .one().c;
      expect(count).toBe(3);
    });
  });
});
