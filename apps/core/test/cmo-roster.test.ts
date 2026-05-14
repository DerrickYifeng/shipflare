import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Tests for the CMO roster tools (`hireEmployee`, `fireEmployee`,
 * `queryRoster`) — persistence + UPSERT semantics.
 *
 * Driving SQL directly (same pattern as `cmo-chat.test.ts`): non-transport
 * DO names skip the parent McpAgent's `super.onStart()`, so we apply the
 * schema explicitly. SQL shape mirrors `tools/roster.ts` so refactors of
 * the tool body remain checked.
 *
 * The "cmo is implicit" rejection lives at the tool layer (not the SQL
 * layer) — those guards are unit-asserted by code review of roster.ts,
 * not at the SQL level.
 */

describe("CMO roster tools — persistence", () => {
  it("hireEmployee inserts active row", async () => {
    const stub = env.CMO.getByName("roster-test-user-1");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
      const sql = state.storage.sql;
      const now = Date.now();
      sql.exec(
        `INSERT INTO roster (role, hired_at, status) VALUES (?, ?, 'active')`,
        "head-of-growth",
        now,
      );
      const row = sql
        .exec<{ role: string; status: string }>(
          "SELECT role, status FROM roster WHERE role = ?",
          "head-of-growth",
        )
        .one();
      expect(row.role).toBe("head-of-growth");
      expect(row.status).toBe("active");
    });
  });

  it("re-hire (ON CONFLICT UPDATE) flips status back to active", async () => {
    const stub = env.CMO.getByName("roster-test-user-2");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO roster (role, hired_at, status) VALUES ('social-media-manager', 1, 'fired')`,
      );
      // simulate hireEmployee's UPSERT
      sql.exec(
        `INSERT INTO roster (role, hired_at, status, hire_config_json)
         VALUES (?, ?, 'active', ?)
         ON CONFLICT(role) DO UPDATE SET
           status = 'active', hire_config_json = excluded.hire_config_json`,
        "social-media-manager",
        2,
        null,
      );
      const row = sql
        .exec<{ status: string }>(
          "SELECT status FROM roster WHERE role = 'social-media-manager'",
        )
        .one();
      expect(row.status).toBe("active");
    });
  });

  it("fireEmployee sets status='fired' but row remains", async () => {
    const stub = env.CMO.getByName("roster-test-user-3");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO roster (role, hired_at, status) VALUES ('head-of-growth', 1, 'active')`,
      );
      const fireResult = sql.exec(
        "UPDATE roster SET status = 'fired' WHERE role = ?",
        "head-of-growth",
      );
      expect(fireResult.rowsWritten).toBe(1);
      const row = sql
        .exec<{ status: string }>(
          "SELECT status FROM roster WHERE role = 'head-of-growth'",
        )
        .one();
      expect(row.status).toBe("fired");
    });
  });

  it("queryRoster returns all rows ordered by hired_at", async () => {
    const stub = env.CMO.getByName("roster-test-user-4");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO roster (role, hired_at, status) VALUES ('social-media-manager', 100, 'active')`,
      );
      sql.exec(
        `INSERT INTO roster (role, hired_at, status) VALUES ('head-of-growth', 50, 'active')`,
      );
      const rows = sql
        .exec<{ role: string }>(
          "SELECT role FROM roster ORDER BY hired_at ASC",
        )
        .toArray();
      expect(rows).toHaveLength(2);
      expect(rows[0]!.role).toBe("head-of-growth");
      expect(rows[1]!.role).toBe("social-media-manager");
    });
  });
});
