import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import type { CMO } from "../src/agents/cmo/CMO";

describe("CMO @callable surface", () => {
  describe("queryRoster", () => {
    it("returns 3 active employees derived from EMPLOYEE_REGISTRY", async () => {
      const stub = env.CMO.getByName("cb-roster-1");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        const rows = await instance.queryRoster();
        expect(rows).toHaveLength(3);
        const roles = rows.map((r) => r.role).sort();
        expect(roles).toEqual([
          "cmo",
          "head-of-growth",
          "social-media-manager",
        ]);
        expect(rows.every((r) => r.status === "active")).toBe(true);
      });
    });
  });

  describe("startNewConversation + listConversations", () => {
    it("INSERT round-trips via listConversations newest-first", async () => {
      const stub = env.CMO.getByName("cb-conv-1");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        const a = await instance.startNewConversation({ title: "first" });
        const b = await instance.startNewConversation();
        const list = await instance.listConversations();
        expect(list).toHaveLength(2);
        expect(list[0]?.id).toBe(b.conversationId);
        expect(list[1]?.id).toBe(a.conversationId);
        expect(list[1]?.title).toBe("first");
      });
    });

    it("limit param clamps between 1 and 100", async () => {
      const stub = env.CMO.getByName("cb-conv-2");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        await instance.startNewConversation();
        const tooSmall = await instance.listConversations({ limit: 0 });
        const tooBig = await instance.listConversations({ limit: 99999 });
        expect(tooSmall).toHaveLength(1);
        expect(tooBig).toHaveLength(1);
      });
    });
  });

  describe("queryDrafts + approveDraft + rejectDraft", () => {
    it("approveDraft flips decision on matching row", async () => {
      const stub = env.CMO.getByName("cb-draft-1");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        state.storage.sql.exec(
          `INSERT INTO approval_queue (id, draft_id, employee, kind, channel, preview, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          "row-1",
          "draft-1",
          "smm",
          "post",
          "x",
          "preview",
          Date.now(),
        );
        const out = await instance.approveDraft({ draftId: "draft-1" });
        expect(out).toEqual({ draftId: "draft-1", decision: "approved" });
        const drafts = await instance.queryDrafts();
        expect(drafts).toHaveLength(1);
        expect((drafts[0] as { decision: string }).decision).toBe("approved");
      });
    });

    it("approveDraft throws on unknown draftId", async () => {
      const stub = env.CMO.getByName("cb-draft-2");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        await expect(
          instance.approveDraft({ draftId: "no-such" }),
        ).rejects.toThrow("not in approval_queue");
      });
    });

    it("approveDraft throws on already-decided draft (Task 3 idempotency fix)", async () => {
      const stub = env.CMO.getByName("cb-draft-already");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        state.storage.sql.exec(
          `INSERT INTO approval_queue (id, draft_id, employee, kind, channel, preview, created_at, decided_at, decision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          "row-d",
          "draft-d",
          "smm",
          "post",
          "x",
          "preview",
          Date.now() - 1000,
          Date.now() - 500,
          "approved",
        );
        await expect(
          instance.approveDraft({ draftId: "draft-d" }),
        ).rejects.toThrow("already decided");
        await expect(
          instance.rejectDraft({ draftId: "draft-d" }),
        ).rejects.toThrow("already decided");
      });
    });

    it("rejectDraft flips decision; tolerates optional reason", async () => {
      const stub = env.CMO.getByName("cb-draft-3");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        state.storage.sql.exec(
          `INSERT INTO approval_queue (id, draft_id, employee, kind, channel, preview, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          "row-r",
          "draft-r",
          "smm",
          "post",
          "x",
          "preview",
          Date.now(),
        );
        const out = await instance.rejectDraft({ draftId: "draft-r", reason: "bad voice" });
        expect(out).toEqual({ draftId: "draft-r", decision: "rejected" });
      });
    });
  });

  describe("queryPlanItems + cancelPlanItem", () => {
    it("cancelPlanItem flips status to cancelled + stamps completed_at", async () => {
      const stub = env.CMO.getByName("cb-plan-1");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        state.storage.sql.exec(
          `INSERT INTO plan_items (id, skill, channel, params_json, status, owner_role)
           VALUES (?, ?, ?, ?, 'pending', ?)`,
          "plan-1",
          "draft-post",
          "x",
          "{}",
          "smm",
        );
        const out = await instance.cancelPlanItem({ id: "plan-1" });
        expect(out).toEqual({ id: "plan-1", status: "cancelled" });
        const items = await instance.queryPlanItems({});
        expect((items[0] as { status: string }).status).toBe("cancelled");
        expect((items[0] as { completed_at: number }).completed_at).toBeGreaterThan(0);
      });
    });

    it("cancelPlanItem throws on terminal status", async () => {
      const stub = env.CMO.getByName("cb-plan-2");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        state.storage.sql.exec(
          `INSERT INTO plan_items (id, skill, channel, params_json, status, owner_role, completed_at)
           VALUES (?, ?, ?, ?, 'completed', ?, ?)`,
          "plan-done",
          "draft-post",
          "x",
          "{}",
          "smm",
          Date.now(),
        );
        await expect(
          instance.cancelPlanItem({ id: "plan-done" }),
        ).rejects.toThrow("already terminal");
      });
    });

    it("queryPlanItems filters by status + ownerRole", async () => {
      const stub = env.CMO.getByName("cb-plan-3");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        const insert = (id: string, status: string, role: string) =>
          state.storage.sql.exec(
            `INSERT INTO plan_items (id, skill, channel, params_json, status, owner_role)
             VALUES (?, 'draft-post', 'x', '{}', ?, ?)`,
            id, status, role,
          );
        insert("p1", "pending", "smm");
        insert("p2", "completed", "smm");
        insert("p3", "pending", "hog");
        expect((await instance.queryPlanItems({ status: "pending" }))).toHaveLength(2);
        expect((await instance.queryPlanItems({ ownerRole: "smm" }))).toHaveLength(2);
        expect(
          (await instance.queryPlanItems({ status: "pending", ownerRole: "smm" })),
        ).toHaveLength(1);
      });
    });
  });

  describe("rememberThis + queryMemory + forgetThis", () => {
    it("INSERT + filter active=1 + soft-delete cycle", async () => {
      const stub = env.CMO.getByName("cb-mem-1");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        const a = await instance.rememberThis({ content: "voice: terse" });
        const b = await instance.rememberThis({ content: "audience: founders" });
        expect((await instance.queryMemory()).length).toBe(2);
        await instance.forgetThis({ id: a.id });
        const after = await instance.queryMemory();
        expect(after).toHaveLength(1);
        expect((after[0] as { id: string }).id).toBe(b.id);
      });
    });

    it("forgetThis throws on unknown id", async () => {
      const stub = env.CMO.getByName("cb-mem-2");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        await expect(instance.forgetThis({ id: "nope" })).rejects.toThrow(
          "memory not found",
        );
      });
    });
  });

  describe("queryFounderContext + queryAgentTranscript", () => {
    it("queryFounderContext returns the KV map", async () => {
      const stub = env.CMO.getByName("cb-ctx-1");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        state.storage.sql.exec(
          "INSERT INTO founder_context (key, value) VALUES (?, ?), (?, ?)",
          "productName", "ShipFlare",
          "voice", "terse",
        );
        const ctx = await instance.queryFounderContext();
        expect(ctx).toEqual({ productName: "ShipFlare", voice: "terse" });
      });
    });

    it("queryAgentTranscript filters by role + caps limit", async () => {
      const stub = env.CMO.getByName("cb-tx-1");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        const insert = (role: string, summary: string, ts: number) =>
          state.storage.sql.exec(
            `INSERT INTO employee_log (from_role, kind, summary, ts)
             VALUES (?, 'task', ?, ?)`,
            role, summary, ts,
          );
        insert("smm", "draft a", 1000);
        insert("smm", "draft b", 2000);
        insert("hog", "research", 1500);
        const rows = await instance.queryAgentTranscript({ role: "smm" });
        expect(rows).toHaveLength(2);
        expect((rows[0] as { summary: string }).summary).toBe("draft b");
      });
    });
  });
});
