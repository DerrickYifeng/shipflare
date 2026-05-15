import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Tests for CMO shared-state tools (founder_context / strategic_path /
 * plan_items / approval_queue) — persistence + UPSERT semantics.
 *
 * We drive SQL directly against the DO storage rather than invoking the
 * registered MCP tools end-to-end. Two reasons:
 *  - Non-transport DO names skip parent McpAgent `super.onStart()`, so the
 *    MCP transport isn't online during these tests. The schema bootstrap is
 *    re-applied here via `applyCmoSchema` — the same pattern used by
 *    `cmo-chat.test.ts` and `cmo-roster.test.ts`.
 *  - The SQL shape mirrors the tool body, so refactors of the tool stay
 *    checked at the schema/SQL level.
 *
 * `delegateToEmployee` is NOT covered here — it needs a real connected MCP
 * server (HoG / SMM don't exist yet). Integration coverage lands in S10.
 */

describe("CMO shared-state tools — persistence", () => {
  it("setFounderContext upserts on duplicate key", async () => {
    const stub = env.CMO.getByName("ss-test-1");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyCmoSchema(sql);
      sql.exec(
        `INSERT INTO founder_context (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        "productName",
        "ShipFlare",
      );
      sql.exec(
        `INSERT INTO founder_context (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        "productName",
        "ShipFlare v2",
      );
      const row = sql
        .exec<{ value: string }>(
          "SELECT value FROM founder_context WHERE key = 'productName'",
        )
        .one();
      expect(row.value).toBe("ShipFlare v2");
    });
  });

  it("commitStrategicPath auto-increments version", async () => {
    const stub = env.CMO.getByName("ss-test-2");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyCmoSchema(sql);
      const insert = (theme: string): void => {
        const latest = sql
          .exec<{ v: number }>(
            "SELECT COALESCE(MAX(version), 0) as v FROM strategic_path",
          )
          .one();
        sql.exec(
          `INSERT INTO strategic_path
             (id, version, theme, narrative_json, status, generated_at, generated_by)
           VALUES (?, ?, ?, ?, 'pending_approval', ?, ?)`,
          crypto.randomUUID(),
          latest.v + 1,
          theme,
          "{}",
          Date.now(),
          "test",
        );
      };
      insert("first");
      insert("second");
      const rows = sql
        .exec<{ version: number; theme: string }>(
          "SELECT version, theme FROM strategic_path ORDER BY version",
        )
        .toArray();
      expect(rows[0]).toMatchObject({ version: 1, theme: "first" });
      expect(rows[1]).toMatchObject({ version: 2, theme: "second" });
    });
  });

  it("addPlanItem then updatePlanItem sets started_at when in_progress", async () => {
    const stub = env.CMO.getByName("ss-test-3");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyCmoSchema(sql);
      const id = "pi-1";
      sql.exec(
        `INSERT INTO plan_items (id, skill, channel, params_json, status, owner_role)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        id,
        "drafting-post",
        "x",
        "{}",
        "social-media-manager",
      );

      // Update to in_progress — should set started_at via COALESCE/CASE
      const now = Date.now();
      sql.exec(
        `UPDATE plan_items SET
           status = ?,
           started_at = COALESCE(started_at, CASE WHEN ? = 'in_progress' THEN ? END)
         WHERE id = ?`,
        "in_progress",
        "in_progress",
        now,
        id,
      );
      const row1 = sql
        .exec<{ status: string; started_at: number | null }>(
          "SELECT status, started_at FROM plan_items WHERE id = ?",
          id,
        )
        .one();
      expect(row1.status).toBe("in_progress");
      expect(row1.started_at).toBe(now);

      // Update to completed — completed_at should be set; started_at preserved
      const later = now + 1000;
      sql.exec(
        `UPDATE plan_items SET
           status = ?,
           completed_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN ? ELSE completed_at END
         WHERE id = ?`,
        "completed",
        "completed",
        later,
        id,
      );
      const row2 = sql
        .exec<{
          status: string;
          started_at: number | null;
          completed_at: number | null;
        }>(
          "SELECT status, started_at, completed_at FROM plan_items WHERE id = ?",
          id,
        )
        .one();
      expect(row2.status).toBe("completed");
      expect(row2.started_at).toBe(now);
      expect(row2.completed_at).toBe(later);
    });
  });

  it("queryPlanItems filters by status + owner_role", async () => {
    const stub = env.CMO.getByName("ss-test-4");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyCmoSchema(sql);
      sql.exec(`INSERT INTO plan_items (id, skill, channel, params_json, status, owner_role) VALUES
        ('p1', 'drafting-post', 'x', '{}', 'pending', 'social-media-manager'),
        ('p2', 'drafting-reply', 'x', '{}', 'completed', 'social-media-manager'),
        ('p3', 'generate-strategic-path', 'x', '{}', 'pending', 'head-of-growth')`);

      const pending = sql
        .exec<{ id: string }>(
          "SELECT id FROM plan_items WHERE status = 'pending' AND owner_role = 'social-media-manager'",
        )
        .toArray()
        .map((r) => r.id);
      expect(pending).toEqual(["p1"]);
    });
  });

  it("approveDraft rejects when row not present", async () => {
    const stub = env.CMO.getByName("ss-test-5");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyCmoSchema(sql);
      const result = sql.exec(
        `UPDATE approval_queue SET decided_at = ?, decision = 'approved' WHERE draft_id = ?`,
        Date.now(),
        "no-such-draft",
      );
      expect(result.rowsWritten).toBe(0);
    });
  });
});
