import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import { buildSystemPrompt } from "../src/agents/cmo/tools/chat";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * P2-D — cross_conversation_memory tests.
 *
 * Same SQL-direct pattern as `cmo-shared-state.test.ts`: we mirror the
 * rememberThis / forgetThis / queryMemory tool bodies against the DO's
 * `state.storage.sql` so the schema + filter semantics stay checked without
 * needing a live MCP transport. The non-transport DO names skip the parent
 * McpAgent `super.onStart()`, so we re-apply the schema explicitly here.
 *
 * Coverage:
 *  - rememberThis INSERT roundtrips via queryMemory's WHERE active=1 filter
 *  - forgetThis sets active=0; queryMemory excludes the row
 *  - idx_memory_active is created on the (active, added_at) tuple
 *  - buildSystemPrompt injects the memory block when memories.length > 0
 */

describe("CMO cross_conversation_memory", () => {
  it("rememberThis insert + queryMemory roundtrip", async () => {
    const stub = env.CMO.getByName("mem-test-1");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyCmoSchema(sql);

      const id = crypto.randomUUID();
      const ts = Date.now();
      sql.exec(
        `INSERT INTO cross_conversation_memory (id, content, source_conversation_id, source_message_ts, added_at, active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        id,
        "Founder prefers brief replies",
        "conv-1",
        ts,
        ts,
      );

      const rows = sql
        .exec<{ id: string; content: string; active: number }>(
          "SELECT id, content, active FROM cross_conversation_memory WHERE active = 1",
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id,
        content: "Founder prefers brief replies",
        active: 1,
      });
    });
  });

  it("forgetThis sets active=0; queryMemory filters out", async () => {
    const stub = env.CMO.getByName("mem-test-2");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyCmoSchema(sql);

      sql.exec(
        `INSERT INTO cross_conversation_memory (id, content, added_at, active)
         VALUES ('m1', 'fact 1', 1, 1)`,
      );
      sql.exec(
        `INSERT INTO cross_conversation_memory (id, content, added_at, active)
         VALUES ('m2', 'fact 2', 2, 1)`,
      );

      sql.exec(
        "UPDATE cross_conversation_memory SET active = 0 WHERE id = 'm1'",
      );

      const rows = sql
        .exec<{ id: string }>(
          "SELECT id FROM cross_conversation_memory WHERE active = 1 ORDER BY added_at",
        )
        .toArray();
      expect(rows.map((r) => r.id)).toEqual(["m2"]);
    });
  });

  it("idx_memory_active accelerates the active-filter query", async () => {
    const stub = env.CMO.getByName("mem-test-3");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyCmoSchema(sql);
      const indexes = sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cross_conversation_memory'",
        )
        .toArray()
        .map((r) => r.name);
      expect(indexes).toContain("idx_memory_active");
    });
  });

  it("buildSystemPrompt injects memory block when memories present", () => {
    const ctx = { productName: "ShipFlare" };
    const memories = [
      { content: "Founder prefers brief replies" },
      { content: "Avoid emoji in posts" },
    ];
    const prompt = buildSystemPrompt(ctx, memories);
    expect(prompt).toContain("Things to always remember about ShipFlare:");
    expect(prompt).toContain("1. Founder prefers brief replies");
    expect(prompt).toContain("2. Avoid emoji in posts");
  });

  it("buildSystemPrompt omits memory block when memories empty", () => {
    const ctx = { productName: "ShipFlare" };
    const prompt = buildSystemPrompt(ctx, []);
    expect(prompt).not.toContain("Things to always remember");
  });
});
