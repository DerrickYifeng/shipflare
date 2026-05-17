import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import { mirrorDraft } from "../src/lib/mirror-draft";
import type { CMO } from "../src/agents/cmo/CMO";

async function bootstrap(stub: DurableObjectStub<CMO>) {
  await runInDurableObject(stub, async (_inst: CMO, state) => {
    applyCmoSchema(state.storage.sql);
  });
}

describe("CMO /internal/mirror-draft", () => {
  it("rejects POST without x-shipflare-internal header", async () => {
    const userId = "md-1";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    const res = await stub.fetch(
      new Request("https://internal/internal/mirror-draft", {
        method: "POST",
        body: JSON.stringify({
          draftId: "x", employee: "smm", kind: "reply", channel: "x",
          preview: "p", createdAt: 1,
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("inserts an approval_queue row", async () => {
    const userId = "md-2";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await bootstrap(stub);
    await mirrorDraft(env.CMO, userId, {
      draftId: "d1", employee: "smm", kind: "post", channel: "reddit",
      preview: "preview text", createdAt: 12345,
    });
    await runInDurableObject(stub, async (_inst: CMO, state) => {
      const rows = state.storage.sql
        .exec("SELECT draft_id, employee, kind, channel, preview, created_at FROM approval_queue")
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        draft_id: "d1", employee: "smm", kind: "post", channel: "reddit",
        preview: "preview text", created_at: 12345,
      });
    });
  });

  it("is idempotent on duplicate draftId", async () => {
    const userId = "md-3";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await bootstrap(stub);
    const body = {
      draftId: "dup", employee: "smm" as const, kind: "reply" as const,
      channel: "x" as const, preview: "p", createdAt: 1,
    };
    await mirrorDraft(env.CMO, userId, body);
    await mirrorDraft(env.CMO, userId, body);
    await runInDurableObject(stub, async (_inst: CMO, state) => {
      const rows = state.storage.sql
        .exec("SELECT id FROM approval_queue WHERE draft_id = 'dup'")
        .toArray();
      expect(rows).toHaveLength(1);
    });
  });

  it("returns 400 on invalid body (missing draftId)", async () => {
    const userId = "md-4";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await bootstrap(stub);
    const res = await stub.fetch(
      new Request("https://internal/internal/mirror-draft", {
        method: "POST",
        headers: { "x-shipflare-internal": "1", "content-type": "application/json" },
        body: JSON.stringify({ employee: "smm", kind: "reply", channel: "x", preview: "p", createdAt: 1 }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
