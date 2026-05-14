import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { applyHogSchema } from "../src/agents/head-of-growth/schema";
import type { HeadOfGrowth } from "../src/agents/head-of-growth/HeadOfGrowth";

/**
 * Persistence-shape tests for the HoG `generate_strategic_path` tool.
 *
 * Same pattern as `hog-schema.test.ts`: we drive the tool's SQL writes
 * directly rather than invoke the McpAgent transport, because
 * `super.onStart()` requires a transport-prefixed DO name to bootstrap
 * the MCP wiring and tests use plain (`hog-plan-*`) names.
 *
 * The Anthropic call inside the tool is hard to assert without burning
 * budget and is environmentally non-deterministic; here we cover the SQL
 * persistence + scoping invariants that come from the tool's body.
 *
 * Tool-registration coverage rides on HoG's `init()` calling
 * `registerStrategicPathTool(this)` — this file imports the agent type
 * so a typecheck regression in the wiring surfaces in CI.
 */
describe("HoG generate_strategic_path — persistence shape", () => {
  it("planning_chat round-trip with conversation scope", async () => {
    const stub = env.HEAD_OF_GROWTH.getByName("hog-plan-1");
    await runInDurableObject(stub, async (_instance: HeadOfGrowth, state) => {
      const sql = state.storage.sql;
      applyHogSchema(sql);

      // Simulate the tool's INSERTs
      const conv = "conv-1";
      const ts = Date.now();
      sql.exec(
        "INSERT INTO planning_chat (conversation_id, role, content, ts) VALUES (?, ?, ?, ?)",
        conv,
        "user",
        "what's our wedge?",
        ts,
      );
      sql.exec(
        "INSERT INTO planning_chat (conversation_id, role, content, ts) VALUES (?, ?, ?, ?)",
        conv,
        "assistant",
        "indie SaaS founders shipping the wrong thing",
        ts + 1,
      );

      const rows = sql
        .exec<{ role: string; content: string }>(
          "SELECT role, content FROM planning_chat WHERE conversation_id = ? ORDER BY ts",
          conv,
        )
        .toArray();

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ role: "user" });
      expect(rows[1]).toMatchObject({ role: "assistant" });
    });
  });

  it("proposal_drafts insert with confidence + alternatives_json", async () => {
    const stub = env.HEAD_OF_GROWTH.getByName("hog-plan-2");
    await runInDurableObject(stub, async (_instance: HeadOfGrowth, state) => {
      const sql = state.storage.sql;
      applyHogSchema(sql);

      const id = crypto.randomUUID();
      sql.exec(
        `INSERT INTO proposal_drafts (id, theme, narrative_md, status, alternatives_json, confidence, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        id,
        "Test theme",
        "Some narrative",
        JSON.stringify([{ alt: "B" }]),
        0.7,
        Date.now(),
      );

      const row = sql
        .exec<{
          theme: string;
          confidence: number;
          alternatives_json: string;
        }>(
          "SELECT theme, confidence, alternatives_json FROM proposal_drafts WHERE id = ?",
          id,
        )
        .one();

      expect(row.theme).toBe("Test theme");
      expect(row.confidence).toBe(0.7);
      expect(JSON.parse(row.alternatives_json)).toEqual([{ alt: "B" }]);
    });
  });

  it("conversation scope: planning chat in A doesn't leak into B", async () => {
    const stub = env.HEAD_OF_GROWTH.getByName("hog-plan-3");
    await runInDurableObject(stub, async (_instance: HeadOfGrowth, state) => {
      const sql = state.storage.sql;
      applyHogSchema(sql);

      sql.exec(
        "INSERT INTO planning_chat (conversation_id, role, content, ts) VALUES ('A', 'user', 'goal A', 1)",
      );
      sql.exec(
        "INSERT INTO planning_chat (conversation_id, role, content, ts) VALUES ('B', 'user', 'goal B', 2)",
      );

      const aRows = sql
        .exec<{ content: string }>(
          "SELECT content FROM planning_chat WHERE conversation_id = 'A'",
        )
        .toArray();
      expect(aRows).toHaveLength(1);
      expect(aRows[0]!.content).toBe("goal A");
    });
  });
});
