import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applySmmSchema } from "../../src/agents/social-media-manager/schema";
import { applyCmoSchema } from "../../src/agents/cmo/schema";
import { transportName } from "../../src/lib/do-name";
import type { SMM } from "../../src/agents/social-media-manager/SocialMediaMgr";
import type { CMO } from "../../src/agents/cmo/CMO";

describe("SMM tool process_posts_batch", () => {
  it("drafts a Reddit post (title+body), persists to drafts, mirrors to CMO", async () => {
    const userId = "smm-ppb-1";

    const cmoStub = env.CMO.getByName(transportName(userId));
    await runInDurableObject<CMO, void>(cmoStub, async (_inst, state) => applyCmoSchema(state.storage.sql));

    const smmStub = env.SMM.get(env.SMM.idFromName(userId));
    await runInDurableObject<SMM, void>(smmStub, async (_inst, state) => applySmmSchema(state.storage.sql));

    await runInDurableObject<SMM, void>(smmStub, async (instance) => {
      const tool = instance.getTools().process_posts_batch!;
      const parsed = (tool.inputSchema as z.ZodTypeAny).parse({
        planItemIds: ["pi1"],
        context: JSON.stringify({
          productName: "TestProd",
          voice: "friendly",
          planItems: [
            { id: "pi1", channel: "reddit", topic: "launch", paramsJson: "{}" },
          ],
        }),
        _dryRunDrafts: [{
          planItemId: "pi1",
          title: "Launching TestProd today",
          body: "Hey r/saas, we just shipped...",
        }],
      });
      const res = await tool.execute!(parsed, {
        experimental_context: { env: instance.bindings, userId },
      } as never);
      expect(res).toMatchObject({ drafted: 1, failed: 0 });
    });

    // SMM drafts row — kind='post', channel='reddit', body_title set
    await runInDurableObject<SMM, void>(smmStub, async (_inst, state) => {
      const rows = state.storage.sql
        .exec("SELECT plan_item_id, kind, channel, body, body_title, status FROM drafts")
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        plan_item_id: "pi1", kind: "post", channel: "reddit",
        body_title: "Launching TestProd today", status: "mirrored",
      });
    });

    // CMO approval_queue row — kind='post'
    await runInDurableObject<CMO, void>(cmoStub, async (_inst, state) => {
      const aq = state.storage.sql
        .exec("SELECT draft_id, employee, kind, channel FROM approval_queue")
        .toArray();
      expect(aq).toHaveLength(1);
      expect(aq[0]).toMatchObject({ employee: "smm", kind: "post", channel: "reddit" });
    });
  });

  it("drafts an X post (body only, no title), persists + mirrors", async () => {
    const userId = "smm-ppb-2";

    const cmoStub = env.CMO.getByName(transportName(userId));
    await runInDurableObject<CMO, void>(cmoStub, async (_inst, state) => applyCmoSchema(state.storage.sql));

    const smmStub = env.SMM.get(env.SMM.idFromName(userId));
    await runInDurableObject<SMM, void>(smmStub, async (_inst, state) => applySmmSchema(state.storage.sql));

    await runInDurableObject<SMM, void>(smmStub, async (instance) => {
      const tool = instance.getTools().process_posts_batch!;
      const parsed = (tool.inputSchema as z.ZodTypeAny).parse({
        planItemIds: ["pi2"],
        context: JSON.stringify({
          productName: "TestProd",
          planItems: [{ id: "pi2", channel: "x", topic: "feature", paramsJson: "{}" }],
        }),
        _dryRunDrafts: [{ planItemId: "pi2", body: "Just shipped TestProd v2.0 🚀" }],
      });
      const res = await tool.execute!(parsed, {
        experimental_context: { env: instance.bindings, userId },
      } as never);
      expect(res).toMatchObject({ drafted: 1, failed: 0 });
    });

    await runInDurableObject<SMM, void>(smmStub, async (_inst, state) => {
      const rows = state.storage.sql
        .exec("SELECT kind, channel, body, body_title FROM drafts")
        .toArray() as Array<{ kind: string; channel: string; body: string; body_title: string | null }>;
      expect(rows[0]).toMatchObject({ kind: "post", channel: "x", body_title: null });
    });
  });

  it("plan item missing from context → status='failed', no mirror", async () => {
    const userId = "smm-ppb-3";

    const cmoStub = env.CMO.getByName(transportName(userId));
    await runInDurableObject<CMO, void>(cmoStub, async (_inst, state) => applyCmoSchema(state.storage.sql));

    const smmStub = env.SMM.get(env.SMM.idFromName(userId));
    await runInDurableObject<SMM, void>(smmStub, async (_inst, state) => applySmmSchema(state.storage.sql));

    await runInDurableObject<SMM, void>(smmStub, async (instance) => {
      const tool = instance.getTools().process_posts_batch!;
      const parsed = (tool.inputSchema as z.ZodTypeAny).parse({
        planItemIds: ["pi-missing"],
        context: JSON.stringify({ planItems: [] }),  // empty — pi-missing not provided
        _dryRunDrafts: [{ planItemId: "pi-missing", body: "anything" }],
      });
      const res = await tool.execute!(parsed, {
        experimental_context: { env: instance.bindings, userId },
      } as never);
      expect(res).toMatchObject({ drafted: 0, failed: 1 });
    });

    await runInDurableObject<CMO, void>(cmoStub, async (_inst, state) => {
      const rows = state.storage.sql.exec("SELECT COUNT(*) AS c FROM approval_queue").toArray() as Array<{ c: number }>;
      expect(rows[0]!.c).toBe(0);
    });
  });

  it("smoke: process_posts_batch registered", async () => {
    const userId = "smm-ppb-4";
    const stub = env.SMM.get(env.SMM.idFromName(userId));
    await runInDurableObject<SMM, void>(stub, async (instance) => {
      expect(Object.keys(instance.getTools())).toContain("process_posts_batch");
    });
  });
});
