import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import { postStrategicPathProposal } from "../src/lib/strategic-path-proposal";
import type { CMO } from "../src/agents/cmo/CMO";

async function bootstrap(stub: DurableObjectStub<CMO>) {
  await runInDurableObject(stub, async (_inst: CMO, state) => {
    applyCmoSchema(state.storage.sql);
  });
}

describe("CMO /internal/strategic-path-proposal", () => {
  it("rejects POST without x-shipflare-internal header", async () => {
    const userId = "spp-1";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    const res = await stub.fetch(
      new Request("https://internal/internal/strategic-path-proposal", {
        method: "POST",
        body: JSON.stringify({
          version: 1, theme: "wedge", narrativeJson: "{}",
          generatedAt: 1, generatedBy: "hog",
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("inserts a strategic_path row with status='proposed'", async () => {
    const userId = "spp-2";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await bootstrap(stub);
    await postStrategicPathProposal(env.CMO, userId, {
      version: 1, theme: "founder-led growth", narrativeJson: '{"wedge":"X"}',
      generatedAt: 12345, generatedBy: "hog",
    });
    await runInDurableObject(stub, async (_inst: CMO, state) => {
      const rows = state.storage.sql
        .exec("SELECT version, theme, narrative_json, status, generated_at, generated_by FROM strategic_path")
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        version: 1, theme: "founder-led growth", narrative_json: '{"wedge":"X"}',
        status: "proposed", generated_at: 12345, generated_by: "hog",
      });
    });
  });

  it("is idempotent on duplicate (version, generated_by)", async () => {
    const userId = "spp-3";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await bootstrap(stub);
    const body = {
      version: 7, theme: "t", narrativeJson: "{}",
      generatedAt: 1, generatedBy: "hog" as const,
    };
    await postStrategicPathProposal(env.CMO, userId, body);
    await postStrategicPathProposal(env.CMO, userId, body);
    await runInDurableObject(stub, async (_inst: CMO, state) => {
      const rows = state.storage.sql
        .exec("SELECT id FROM strategic_path WHERE version = 7 AND generated_by = 'hog'")
        .toArray();
      expect(rows).toHaveLength(1);
    });
  });

  it("returns 400 on invalid body (missing version)", async () => {
    const userId = "spp-4";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await bootstrap(stub);
    const res = await stub.fetch(
      new Request("https://internal/internal/strategic-path-proposal", {
        method: "POST",
        headers: { "x-shipflare-internal": "1", "content-type": "application/json" },
        body: JSON.stringify({ theme: "t", narrativeJson: "{}", generatedAt: 1, generatedBy: "hog" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
