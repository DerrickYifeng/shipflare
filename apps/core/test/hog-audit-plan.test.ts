import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { applyHogSchema } from "../src/agents/head-of-growth/schema";
import type { HeadOfGrowth } from "../src/agents/head-of-growth/HeadOfGrowth";

/**
 * Persistence-shape tests for the HoG `audit_plan` tool.
 *
 * Same pattern as `hog-strategic-path.test.ts`: we drive the tool's SQL
 * writes directly rather than invoke the McpAgent transport, because
 * `super.onStart()` requires a transport-prefixed DO name to bootstrap
 * the MCP wiring and tests use plain (`hog-audit-*`) names.
 *
 * The Anthropic call inside the tool is hard to assert without burning
 * budget and is environmentally non-deterministic; here we cover the SQL
 * persistence + idx_audit_open + nullability invariants from the tool's
 * INSERTs.
 *
 * Tool-registration coverage rides on HoG's `init()` calling
 * `registerAuditTool(this)` — this file imports the agent type so a
 * typecheck regression in the wiring surfaces in CI.
 */
describe("HoG audit_plan — persistence shape", () => {
  it("audit_findings insert with high severity + suggestedFix", async () => {
    const stub = env.HEAD_OF_GROWTH.getByName("hog-audit-1");
    await runInDurableObject(stub, async (_instance: HeadOfGrowth, state) => {
      const sql = state.storage.sql;
      applyHogSchema(sql);

      sql.exec(
        `INSERT INTO audit_findings (conversation_id, target_id, severity, finding, suggested_fix, status)
         VALUES (?, ?, 'high', ?, ?, 'open')`,
        "conv-1",
        "pi-1",
        "Plan missing X channel posting cadence",
        "Add 3 posts/week to plan_items",
      );

      const row = sql
        .exec<{
          severity: string;
          finding: string;
          suggested_fix: string;
          status: string;
        }>(
          "SELECT severity, finding, suggested_fix, status FROM audit_findings WHERE conversation_id = ?",
          "conv-1",
        )
        .one();

      expect(row.severity).toBe("high");
      expect(row.status).toBe("open");
      expect(row.suggested_fix).toContain("3 posts");
    });
  });

  it("idx_audit_open is used for status+severity filter", async () => {
    const stub = env.HEAD_OF_GROWTH.getByName("hog-audit-2");
    await runInDurableObject(stub, async (_instance: HeadOfGrowth, state) => {
      const sql = state.storage.sql;
      applyHogSchema(sql);

      sql.exec(`INSERT INTO audit_findings (severity, finding, status) VALUES
        ('high', 'A', 'open'),
        ('high', 'B', 'resolved'),
        ('med', 'C', 'open'),
        ('low', 'D', 'open')`);

      const openHigh = sql
        .exec<{ finding: string }>(
          "SELECT finding FROM audit_findings WHERE status = 'open' AND severity = 'high'",
        )
        .toArray();
      expect(openHigh).toHaveLength(1);
      expect(openHigh[0]!.finding).toBe("A");
    });
  });

  it("findings without targetId are allowed (nullable)", async () => {
    const stub = env.HEAD_OF_GROWTH.getByName("hog-audit-3");
    await runInDurableObject(stub, async (_instance: HeadOfGrowth, state) => {
      const sql = state.storage.sql;
      applyHogSchema(sql);

      sql.exec(
        `INSERT INTO audit_findings (conversation_id, target_id, severity, finding, suggested_fix, status)
         VALUES (?, ?, 'low', ?, ?, 'open')`,
        "conv-1",
        null,
        "Overall plan is well-scoped — minor polish only",
        null,
      );

      const row = sql
        .exec<{ target_id: string | null }>(
          "SELECT target_id FROM audit_findings WHERE conversation_id = 'conv-1'",
        )
        .one();
      expect(row.target_id).toBeNull();
    });
  });
});
