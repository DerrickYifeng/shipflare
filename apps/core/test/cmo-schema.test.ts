import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Smoke tests for the CMO DO's SQLite schema bootstrap.
 *
 * Why we drive `applyCmoSchema` directly rather than `instance.onStart()`:
 * McpAgent's `super.onStart()` calls `getTransportType()` which reads a
 * transport prefix (`sse:` / `streamable-http:` / `rpc:`) from the DO name.
 * Non-transport-named DOs throw at that line. The CMO's `onStart()` runs
 * `applyCmoSchema` BEFORE the super call precisely so the schema can be
 * verified in isolation here (and so the parent transport-init can throw
 * without leaving our tables half-built in production). We invoke
 * `applyCmoSchema` directly against the DO's `state.storage.sql` to assert
 * the contract.
 *
 * Schema queries exclude:
 *   - `sqlite_%` (SQLite's own metadata)
 *   - `_cf_%` (workerd's internal bookkeeping)
 *   - `cf_agents_%` / `cf_agent_%` (Agents framework state tables — runs,
 *     queues, schedules, MCP server registry. The framework writes these
 *     lazily on first use, not at construction time, so they may or may
 *     not exist when we read sqlite_master.)
 *
 * `env.CMO` is typed by the generated `worker-configuration.d.ts`
 * (`Cloudflare.Env.CMO`) which is sourced from wrangler.jsonc bindings.
 */

describe("CMO schema", () => {
  it("applies all 8 retained tables on ensureSchema", async () => {
    const stub = env.CMO.getByName("schema-test-user");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
      const tables = state.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type='table'
             AND name NOT LIKE 'sqlite_%'
             AND name NOT LIKE '_cf_%'
             AND name NOT LIKE 'cf_agents_%'
             AND name NOT LIKE 'cf_agent_%'
             -- AIChatAgent (cf_ai_chat_*) bootstraps its own chat-history
             -- tables on construction; they're orthogonal to applyCmoSchema.
             AND name NOT LIKE 'cf_ai_chat_%'
           ORDER BY name`,
        )
        .toArray()
        .map((r) => r.name);

      // Task 5.1b dropped `conversations`, `founder_messages` (replaced by
      // AIChatAgent's chat-history tables), `roster` (retired with the
      // hire/fire surface), and `activity_events` (replaced by Analytics
      // Engine via writeAgentEvent).
      expect(tables).toEqual([
        "approval_queue",
        "cross_conversation_memory",
        "employee_log",
        "founder_context",
        "plan_items",
        "progress_snapshots",
        "push_subscriptions",
        "strategic_path",
      ]);
    });
  });

  it("plan_items index on (status, owner_role) is present", async () => {
    const stub = env.CMO.getByName("idx-test-user");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
      const indexes = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='plan_items'",
        )
        .toArray()
        .map((r) => r.name);
      expect(indexes).toContain("idx_plan_status");
    });
  });
});
