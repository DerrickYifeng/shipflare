import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * Tests for the CMO `chat` tool's persistence + scope contract.
 *
 * Why we drive the SQL directly rather than the registered tool handler:
 * the tool calls Anthropic in the middle of its flow. Driving the SQL
 * mirrors the tool's INSERT/SELECT pattern (lines in `tools/chat.ts`)
 * so we can assert persistence shape and conversation scope without
 * burning API budget. Live Anthropic integration is exercised separately.
 *
 * Per the schema test in `cmo-schema.test.ts`, `runInDurableObject` is
 * used so `state.storage.sql` is the same SqlStorage the tool would use.
 * `applyCmoSchema` runs in the CMO's `onStart`; this test re-applies it
 * because non-transport DO names skip the parent's `super.onStart()` and
 * therefore skip the schema bootstrap.
 */

import { applyCmoSchema } from "../src/agents/cmo/schema";

describe("CMO chat tool — persistence shape", () => {
  it("user + assistant messages persist with correct ts ordering", async () => {
    const stub = env.CMO.getByName("chat-test-user");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
      const sql = state.storage.sql;

      // Simulate the chat tool's INSERT pattern (mirrors tools/chat.ts).
      const convId = "conv-test-1";
      sql.exec(
        "INSERT INTO conversations (id, started_at) VALUES (?, ?)",
        convId,
        1000,
      );
      sql.exec(
        "INSERT INTO founder_messages (conversation_id, role, content, ts) VALUES (?, ?, ?, ?)",
        convId,
        "user",
        "hello CMO",
        1001,
      );
      sql.exec(
        "INSERT INTO founder_messages (conversation_id, role, content, ts) VALUES (?, ?, ?, ?)",
        convId,
        "assistant",
        "hi founder",
        1002,
      );

      const rows = sql
        .exec<{ role: string; content: string; ts: number }>(
          "SELECT role, content, ts FROM founder_messages WHERE conversation_id = ? ORDER BY ts",
          convId,
        )
        .toArray();

      expect(rows).toHaveLength(2);
      expect(rows[0]!.role).toBe("user");
      expect(rows[0]!.content).toBe("hello CMO");
      expect(rows[1]!.role).toBe("assistant");
      expect(rows[1]!.content).toBe("hi founder");
      expect(rows[0]!.ts).toBeLessThan(rows[1]!.ts);
    });
  });

  it("conversation scope: messages in conv-A don't leak into conv-B", async () => {
    const stub = env.CMO.getByName("scope-test-user");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
      const sql = state.storage.sql;

      sql.exec(
        "INSERT INTO conversations (id, started_at) VALUES (?, ?)",
        "conv-A",
        1,
      );
      sql.exec(
        "INSERT INTO conversations (id, started_at) VALUES (?, ?)",
        "conv-B",
        2,
      );

      sql.exec(
        "INSERT INTO founder_messages (conversation_id, role, content, ts) VALUES (?, ?, ?, ?)",
        "conv-A",
        "user",
        "in A",
        10,
      );
      sql.exec(
        "INSERT INTO founder_messages (conversation_id, role, content, ts) VALUES (?, ?, ?, ?)",
        "conv-B",
        "user",
        "in B",
        20,
      );

      const aRows = sql
        .exec<{ content: string }>(
          "SELECT content FROM founder_messages WHERE conversation_id = ?",
          "conv-A",
        )
        .toArray();
      expect(aRows).toHaveLength(1);
      expect(aRows[0]!.content).toBe("in A");
    });
  });

  it("founder_context survives — used to build system prompt", async () => {
    const stub = env.CMO.getByName("context-test-user");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
      const sql = state.storage.sql;
      sql.exec(
        "INSERT INTO founder_context (key, value) VALUES (?, ?)",
        "productName",
        "ShipFlare",
      );
      sql.exec(
        "INSERT INTO founder_context (key, value) VALUES (?, ?)",
        "voice",
        "tech founder, no fluff",
      );

      const rows = sql
        .exec<{ key: string; value: string }>(
          "SELECT key, value FROM founder_context",
        )
        .toArray();
      const ctx = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      expect(ctx.productName).toBe("ShipFlare");
      expect(ctx.voice).toBe("tech founder, no fluff");
    });
  });
});
