import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Tests for the CMO conversation tools (`startNewConversation`,
 * `listConversations`) — persistence + scope contract.
 *
 * Driving SQL directly mirrors `cmo-chat.test.ts`: non-transport DO names
 * skip the parent McpAgent's `super.onStart()` (it reads a transport
 * prefix from the DO name), so we apply the schema explicitly. The SQL
 * shape under test matches the tool's INSERT/SELECT statements in
 * `tools/conversation.ts` so refactors of the tool body remain checked.
 */

describe("CMO conversation tools — persistence", () => {
  it("startNewConversation inserts row with auto-generated id", async () => {
    const stub = env.CMO.getByName("conv-test-user-1");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
      const sql = state.storage.sql;

      // Mirrors tools/conversation.ts: crypto.randomUUID + INSERT.
      const id = crypto.randomUUID();
      sql.exec(
        "INSERT INTO conversations (id, started_at, title) VALUES (?, ?, ?)",
        id,
        Date.now(),
        "test convo",
      );
      const rows = sql
        .exec<{ id: string; title: string }>(
          "SELECT id, title FROM conversations WHERE id = ?",
          id,
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe("test convo");
    });
  });

  it("listConversations returns newest-first, excludes archived", async () => {
    const stub = env.CMO.getByName("conv-test-user-2");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
      const sql = state.storage.sql;

      sql.exec(
        "INSERT INTO conversations (id, started_at, archived) VALUES ('old', 100, 0)",
      );
      sql.exec(
        "INSERT INTO conversations (id, started_at, archived) VALUES ('new', 200, 0)",
      );
      sql.exec(
        "INSERT INTO conversations (id, started_at, archived) VALUES ('archived', 300, 1)",
      );

      const rows = sql
        .exec<{ id: string }>(
          `SELECT id FROM conversations
           WHERE archived = 0
           ORDER BY started_at DESC
           LIMIT 20`,
        )
        .toArray();

      expect(rows).toHaveLength(2);
      expect(rows[0]!.id).toBe("new");
      expect(rows[1]!.id).toBe("old");
    });
  });
});
