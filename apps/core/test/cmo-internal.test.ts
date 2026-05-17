import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Tests for the CMO's `/internal/*` HTTP handlers — S2.5.
 *
 * Endpoints:
 *  - POST /internal/init             — idempotent default-roster seed
 *  - POST /internal/peer-dm-shadow   — quiet employee_log append (no LLM)
 *
 * Both are gated on `x-shipflare-internal: 1` — the Worker entry
 * sets this for Service-Binding-initiated traffic (S2.6). The 403 path
 * is exercised below.
 *
 * Schema bootstrap note: non-transport DO names (no `sse:`/`streamable-http:`/
 * `rpc:` prefix) skip the parent McpAgent's transport init, which also
 * skips our `onStart` schema bootstrap. The existing CMO test suite
 * works around this by re-applying `applyCmoSchema` via
 * `runInDurableObject` before driving SQL. We do the same here, then
 * exercise the handler through `stub.fetch()`.
 */

const INTERNAL_HEADERS = {
  "x-shipflare-internal": "1",
  "content-type": "application/json",
};

/**
 * Apply the CMO schema to the stub's storage (re-)mirroring the
 * `onStart` bootstrap. Mirrors the pattern in `cmo-chat.test.ts` etc.
 */
async function bootstrap(stub: DurableObjectStub<CMO>): Promise<void> {
  await runInDurableObject(stub, async (_instance: CMO, state) => {
    applyCmoSchema(state.storage.sql);
  });
}

describe("CMO /internal/init", () => {
  it("first call seeds founder_context (roster retired in Task 5.1b)", async () => {
    const stub = env.CMO.getByName("init-test-user-1");
    await bootstrap(stub);

    const res = await stub.fetch(
      new Request("https://x/internal/init", {
        method: "POST",
        headers: INTERNAL_HEADERS,
        body: JSON.stringify({
          email: "founder@example.com",
          githubLogin: "founder42",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("initialized");

    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      const ctx = sql
        .exec<{ key: string; value: string }>(
          "SELECT key, value FROM founder_context ORDER BY key",
        )
        .toArray();
      expect(ctx).toContainEqual({ key: "email", value: "founder@example.com" });
      expect(ctx).toContainEqual({ key: "githubLogin", value: "founder42" });
    });
  });

  it("second call is idempotent (already_initialized, does not overwrite)", async () => {
    const stub = env.CMO.getByName("init-test-user-2");
    await bootstrap(stub);

    // First init
    await stub.fetch(
      new Request("https://x/internal/init", {
        method: "POST",
        headers: INTERNAL_HEADERS,
        body: JSON.stringify({ email: "a@b.c", githubLogin: null }),
      }),
    );
    // Second init — should be a no-op
    const res = await stub.fetch(
      new Request("https://x/internal/init", {
        method: "POST",
        headers: INTERNAL_HEADERS,
        body: JSON.stringify({
          email: "different@b.c",
          githubLogin: "other",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("already_initialized");

    // Verify original values weren't overwritten.
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const email = state.storage.sql
        .exec<{ value: string }>(
          "SELECT value FROM founder_context WHERE key = 'email'",
        )
        .one().value;
      expect(email).toBe("a@b.c");
    });
  });

  it("rejects without x-shipflare-internal header (403)", async () => {
    const stub = env.CMO.getByName("init-test-user-3");
    // No bootstrap needed — the 403 gate fires before the handler touches SQL.
    const res = await stub.fetch(
      new Request("https://x/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.c", githubLogin: null }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("init with null githubLogin skips the githubLogin row", async () => {
    const stub = env.CMO.getByName("init-test-user-4");
    await bootstrap(stub);

    const res = await stub.fetch(
      new Request("https://x/internal/init", {
        method: "POST",
        headers: INTERNAL_HEADERS,
        body: JSON.stringify({
          email: "noghub@example.com",
          githubLogin: null,
        }),
      }),
    );
    expect(await res.text()).toBe("initialized");

    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const ghRows = state.storage.sql
        .exec("SELECT * FROM founder_context WHERE key = 'githubLogin'")
        .toArray();
      expect(ghRows).toHaveLength(0);
    });
  });
});

describe("CMO /internal/peer-dm-shadow", () => {
  it("writes employee_log row with kind=peer_dm_shadow + notified_founder=0", async () => {
    const stub = env.CMO.getByName("shadow-test-1");
    await bootstrap(stub);

    const res = await stub.fetch(
      new Request("https://x/internal/peer-dm-shadow", {
        method: "POST",
        headers: INTERNAL_HEADERS,
        body: JSON.stringify({
          conversationId: "c-abc",
          fromRole: "social-media-manager",
          toRole: "head-of-growth",
          tool: "audit_plan",
          summary: "SMM asked HoG to audit plan xyz",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("logged");

    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const rows = state.storage.sql
        .exec<{
          kind: string;
          from_role: string;
          summary: string;
          notified_founder: number;
        }>(
          "SELECT kind, from_role, summary, notified_founder FROM employee_log",
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "peer_dm_shadow",
        from_role: "social-media-manager",
        notified_founder: 0,
      });
    });
  });

  it("rejects without internal header (403)", async () => {
    const stub = env.CMO.getByName("shadow-test-2");
    const res = await stub.fetch(
      new Request("https://x/internal/peer-dm-shadow", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
  });
});

