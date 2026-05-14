import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyHogSchema } from "../src/agents/head-of-growth/schema";
import type { HeadOfGrowth } from "../src/agents/head-of-growth/HeadOfGrowth";

/**
 * Smoke tests for the HeadOfGrowth DO's SQLite schema bootstrap.
 *
 * Same pattern as `cmo-schema.test.ts` (S2.0): we drive `applyHogSchema`
 * directly rather than `instance.onStart()` because McpAgent's
 * `super.onStart()` calls `getTransportType()` which reads a transport
 * prefix (`sse:` / `streamable-http:` / `rpc:`) from the DO name and
 * throws on non-transport names. HoG.onStart runs `applyHogSchema` BEFORE
 * the super call precisely so the schema can be verified in isolation
 * here.
 *
 * Schema queries exclude:
 *   - `sqlite_%` — SQLite's own metadata
 *   - `_cf_%` — workerd's internal bookkeeping
 *   - `cf_agents_%` / `cf_agent_%` — Agents framework state tables (runs,
 *     queues, schedules, MCP server registry; the framework writes these
 *     lazily on first use, not at construction, so they may or may not
 *     exist when we read sqlite_master).
 */

describe("HeadOfGrowth schema", () => {
  it("applies all 3 tables on onStart", async () => {
    const stub = env.HEAD_OF_GROWTH.getByName("hog-schema-test-user-1");
    await runInDurableObject(stub, async (_instance: HeadOfGrowth, state) => {
      applyHogSchema(state.storage.sql);
      const tables = state.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type='table'
             AND name NOT LIKE 'sqlite_%'
             AND name NOT LIKE '_cf_%'
             AND name NOT LIKE 'cf_agents_%'
             AND name NOT LIKE 'cf_agent_%'
           ORDER BY name`,
        )
        .toArray()
        .map((r) => r.name);

      expect(tables).toEqual([
        "audit_findings",
        "planning_chat",
        "proposal_drafts",
      ]);
    });
  });

  it("planning_chat composite primary key works", async () => {
    const stub = env.HEAD_OF_GROWTH.getByName("hog-schema-test-user-2");
    await runInDurableObject(stub, async (_instance: HeadOfGrowth, state) => {
      applyHogSchema(state.storage.sql);
      const sql = state.storage.sql;
      sql.exec(
        "INSERT INTO planning_chat (conversation_id, role, content, ts) VALUES (?, ?, ?, ?)",
        "conv-1",
        "user",
        "what's our wedge?",
        1001,
      );
      sql.exec(
        "INSERT INTO planning_chat (conversation_id, role, content, ts) VALUES (?, ?, ?, ?)",
        "conv-1",
        "assistant",
        "narrow it to indie SaaS founders",
        1002,
      );
      const rows = sql
        .exec<{ role: string; content: string }>(
          "SELECT role, content FROM planning_chat WHERE conversation_id = ? ORDER BY ts",
          "conv-1",
        )
        .toArray();
      expect(rows).toHaveLength(2);
      expect(rows[0]!.role).toBe("user");
      expect(rows[1]!.role).toBe("assistant");
    });
  });

  it("audit_findings index on (status, severity) is present", async () => {
    const stub = env.HEAD_OF_GROWTH.getByName("hog-schema-test-user-3");
    await runInDurableObject(stub, async (_instance: HeadOfGrowth, state) => {
      applyHogSchema(state.storage.sql);
      const indexes = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_findings'",
        )
        .toArray()
        .map((r) => r.name);
      expect(indexes).toContain("idx_audit_open");
    });
  });
});
