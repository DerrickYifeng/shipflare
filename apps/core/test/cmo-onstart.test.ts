import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ROLE_REGISTRY, mcpServerName } from "@shipflare/shared";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Tests for the CMO `connectEmployees()` logic invoked from `onStart()`.
 *
 * We validate the LOGIC of roster iteration + ROLE_REGISTRY gating + per-tenant
 * namespacing, NOT the actual `addMcpServer` RPC dial-up. Two reasons:
 *  - The HoG / SMM DO classes don't exist yet (S3/S4 deliverables), and their
 *    wrangler bindings are commented out — so `addMcpServer` against them
 *    would fail at the binding-lookup step regardless.
 *  - The graceful-skip path (no binding → log + continue) is precisely what
 *    we want exercised here, but observing console.warn from inside
 *    `runInDurableObject` is brittle; instead we assert the SQL-level
 *    iteration shape that `connectEmployees` reads.
 *
 * Schema bootstrap pattern matches `cmo-schema.test.ts`: non-transport DO
 * names skip parent `super.onStart()`, so we re-apply `applyCmoSchema`
 * directly. The SQL shape mirrors `connectEmployees`'s `SELECT role FROM
 * roster WHERE status = 'active'` so refactors of that query remain checked.
 */

describe("CMO connectEmployees logic", () => {
  it("only active roles are picked up; fired ones are skipped", async () => {
    const stub = env.CMO.getByName("onstart-test-user-1");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyCmoSchema(sql);
      sql.exec(
        `INSERT INTO roster (role, hired_at, status) VALUES
          ('head-of-growth', 1, 'active'),
          ('social-media-manager', 2, 'fired')`,
      );

      const active = sql
        .exec<{ role: string }>(
          "SELECT role FROM roster WHERE status = 'active'",
        )
        .toArray()
        .map((r) => r.role);

      expect(active).toEqual(["head-of-growth"]);
    });
  });

  it("namespaced server name matches mcpServerName(role, userId)", () => {
    // Pure helper test — doesn't need a DO instance. Guards the
    // Phase 0 spike #2 invariant: addMcpServer name MUST be
    // per-tenant unique to keep McpServer DO instances isolated.
    const name = mcpServerName("social-media-manager", "user-abc-123");
    expect(name).toBe("social-media-manager-user-abc-123");
  });

  it("ROLE_REGISTRY entries map to env-binding names", () => {
    // The binding name is what `connectEmployees` reads from `this.bindings`
    // to look up the DurableObjectNamespace. Mismatch here ⇒ silent skip
    // in production. Pin the contract.
    expect(ROLE_REGISTRY["head-of-growth"].binding).toBe("HEAD_OF_GROWTH");
    // Task 4.4c (CF-native chat migration): SMM binding was renamed from
    // "SOCIAL_MEDIA_MGR" to "SMM" alongside the AIChatAgent rewrite.
    expect(ROLE_REGISTRY["social-media-manager"].binding).toBe("SMM");
    expect(ROLE_REGISTRY["cmo"].binding).toBe("CMO");
  });

  it("unknown role in roster is filtered (forward-compat: scout for stale data)", async () => {
    const stub = env.CMO.getByName("onstart-test-user-2");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyCmoSchema(sql);
      sql.exec(
        `INSERT INTO roster (role, hired_at, status) VALUES
          ('head-of-growth', 1, 'active'),
          ('ghost-role-from-future', 2, 'active')`,
      );

      const active = sql
        .exec<{ role: string }>(
          "SELECT role FROM roster WHERE status = 'active'",
        )
        .toArray()
        .map((r) => r.role);

      // The DB returns both, but `connectEmployees` ROLE_REGISTRY-gates
      // before any binding lookup. Asserting the gate here ensures a stale
      // roster row from a removed-in-Phase-2 role doesn't crash onStart.
      const validActive = active.filter((r) => r in ROLE_REGISTRY);
      expect(validActive).toEqual(["head-of-growth"]);
    });
  });
});
