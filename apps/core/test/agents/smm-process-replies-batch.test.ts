import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applySmmSchema } from "../../src/agents/social-media-manager/schema";
import { applyCmoSchema } from "../../src/agents/cmo/schema";
import { transportName } from "../../src/lib/do-name";
import type { SMM } from "../../src/agents/social-media-manager/SocialMediaMgr";
import type { CMO } from "../../src/agents/cmo/CMO";

describe("SMM tool process_replies_batch", () => {
  it("drafts a reply per thread, persists, mirrors to CMO approval_queue, marks thread drafted", async () => {
    const userId = "smm-prb-1";

    // Bootstrap CMO schema (target of mirror POST). mirrorDraft() routes
    // through `transportName(userId)` so we MUST bootstrap on the same name.
    const cmoStub = env.CMO.getByName(transportName(userId));
    await runInDurableObject<CMO, void>(cmoStub, async (_inst, state) => {
      applyCmoSchema(state.storage.sql);
    });

    // Bootstrap SMM schema + seed inbox.
    const smmStub = env.SMM.get(env.SMM.idFromName(userId));
    await runInDurableObject<SMM, void>(smmStub, async (_inst, state) => {
      applySmmSchema(state.storage.sql);
      state.storage.sql.exec(
        `INSERT INTO threads_inbox (id, external_id, platform, content, judge_score, judged_at, discovered_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        "t1", "ext-1", "x", "hello world from a user", 0.8, Date.now(), Date.now(), "pending",
      );
    });

    await runInDurableObject<SMM, void>(smmStub, async (instance) => {
      const tool = instance.getTools().process_replies_batch!;
      const parsed = (tool.inputSchema as z.ZodTypeAny).parse({
        threadIds: ["t1"],
        context: JSON.stringify({ productName: "TestProd", voice: "friendly" }),
        _dryRunDrafts: [{ threadId: "t1", text: "thanks for sharing!" }],
      });
      const res = await tool.execute!(parsed, {
        experimental_context: { env: instance.bindings, userId },
      } as never);
      expect(res).toMatchObject({ drafted: 1, failed: 0 });
    });

    // SMM drafts row + thread marked drafted.
    await runInDurableObject<SMM, void>(smmStub, async (_inst, state) => {
      const drafts = state.storage.sql
        .exec("SELECT thread_id, kind, channel, body, status FROM drafts")
        .toArray();
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        thread_id: "t1", kind: "reply", channel: "x", status: "mirrored",
      });

      const inbox = state.storage.sql
        .exec("SELECT status FROM threads_inbox WHERE id = 't1'")
        .toArray() as Array<{ status: string }>;
      expect(inbox[0]!.status).toBe("drafted");
    });

    // CMO approval_queue row (mirror).
    await runInDurableObject<CMO, void>(cmoStub, async (_inst, state) => {
      const aq = state.storage.sql
        .exec("SELECT draft_id, employee, kind, channel FROM approval_queue")
        .toArray();
      expect(aq).toHaveLength(1);
      expect(aq[0]).toMatchObject({ employee: "smm", kind: "reply", channel: "x" });
    });
  });

  it("validation failure → status='failed', no mirror, threads_inbox still marked drafted", async () => {
    const userId = "smm-prb-2";

    const cmoStub = env.CMO.getByName(transportName(userId));
    await runInDurableObject<CMO, void>(cmoStub, async (_inst, state) => applyCmoSchema(state.storage.sql));

    const smmStub = env.SMM.get(env.SMM.idFromName(userId));
    await runInDurableObject<SMM, void>(smmStub, async (_inst, state) => {
      applySmmSchema(state.storage.sql);
      state.storage.sql.exec(
        `INSERT INTO threads_inbox (id, external_id, platform, content, discovered_at, status)
         VALUES ('t2', 'ext-2', 'x', 'msg', ?, 'pending')`,
        Date.now(),
      );
    });

    await runInDurableObject<SMM, void>(smmStub, async (instance) => {
      const tool = instance.getTools().process_replies_batch!;
      // Sibling-platform leak: drafting a reply for an X thread that mentions
      // Reddit vocabulary trips validateDraft's platform-leak check.
      const parsed = (tool.inputSchema as z.ZodTypeAny).parse({
        threadIds: ["t2"],
        context: "{}",
        _dryRunDrafts: [{ threadId: "t2", text: "Check the subreddit for more" }],
      });
      const res = await tool.execute!(parsed, {
        experimental_context: { env: instance.bindings, userId },
      } as never);
      expect(res).toMatchObject({ drafted: 0, failed: 1 });
    });

    // No approval_queue row.
    await runInDurableObject<CMO, void>(cmoStub, async (_inst, state) => {
      const rows = state.storage.sql.exec("SELECT COUNT(*) AS c FROM approval_queue").toArray() as Array<{ c: number }>;
      expect(rows[0]!.c).toBe(0);
    });

    // drafts row marked failed + threads_inbox marked drafted (processed).
    await runInDurableObject<SMM, void>(smmStub, async (_inst, state) => {
      const draftRows = state.storage.sql.exec("SELECT status, validation_errors FROM drafts").toArray() as Array<{ status: string; validation_errors: string | null }>;
      expect(draftRows).toHaveLength(1);
      expect(draftRows[0]!.status).toBe("failed");
      expect(draftRows[0]!.validation_errors).toBeTruthy();

      const inboxRows = state.storage.sql.exec("SELECT status FROM threads_inbox WHERE id = 't2'").toArray() as Array<{ status: string }>;
      expect(inboxRows[0]!.status).toBe("drafted");
    });
  });

  it("smoke: process_replies_batch registered", async () => {
    const userId = "smm-prb-3";
    const stub = env.SMM.get(env.SMM.idFromName(userId));
    await runInDurableObject<SMM, void>(stub, async (instance) => {
      expect(Object.keys(instance.getTools())).toContain("process_replies_batch");
    });
  });
});
