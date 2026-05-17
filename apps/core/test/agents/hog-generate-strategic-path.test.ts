import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyHogSchema } from "../../src/agents/head-of-growth/schema";
import { applyCmoSchema } from "../../src/agents/cmo/schema";
import { transportName } from "../../src/lib/do-name";
import type { HoG } from "../../src/agents/head-of-growth/HeadOfGrowth";
import type { CMO } from "../../src/agents/cmo/CMO";

describe("HoG tool generate_strategic_path", () => {
  it("inserts proposal_drafts + planning_chat rows; mirrors to CMO strategic_path", async () => {
    const userId = "hog-gsp-1";

    const cmoStub = env.CMO.getByName(transportName(userId));
    await runInDurableObject<CMO, void>(cmoStub, async (_inst, state) => applyCmoSchema(state.storage.sql));

    const hogStub = env.HOG.get(env.HOG.idFromName(userId));
    await runInDurableObject<HoG, void>(hogStub, async (_inst, state) => applyHogSchema(state.storage.sql));

    await runInDurableObject<HoG, void>(hogStub, async (instance) => {
      const tool = instance.getTools().generate_strategic_path!;
      const parsed = (tool.inputSchema as z.ZodTypeAny).parse({
        context: JSON.stringify({ productName: "TestProd", audience: "developers" }),
        goal: "Plan Q3 growth",
        _dryRunNarrative: {
          theme: "developer-first community-led growth",
          narrative: {
            wedge: "open-source SDK first",
            channels: ["GitHub", "Reddit"],
            tactics: ["weekly demos", "office hours"],
            kpis: ["GitHub stars", "discord signups"],
          },
        },
      });
      const res = await tool.execute!(parsed, {
        experimental_context: { env: instance.bindings, userId },
      } as never);
      const r = res as { version: number; theme: string; mirrored: boolean };
      expect(r.version).toBe(1);
      expect(r.theme).toBe("developer-first community-led growth");
      expect(r.mirrored).toBe(true);
    });

    // HoG proposal_drafts row
    await runInDurableObject<HoG, void>(hogStub, async (_inst, state) => {
      const rows = state.storage.sql
        .exec("SELECT version, theme, mirrored_to_cmo FROM proposal_drafts")
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ version: 1, theme: "developer-first community-led growth", mirrored_to_cmo: 1 });
    });

    // HoG planning_chat rows (user + assistant)
    await runInDurableObject<HoG, void>(hogStub, async (_inst, state) => {
      const rows = state.storage.sql
        .exec("SELECT role, content FROM planning_chat ORDER BY id")
        .toArray() as Array<{ role: string; content: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows[0]!.role).toBe("user");
      expect(rows[1]!.role).toBe("assistant");
    });

    // CMO strategic_path mirror — status='proposed'
    await runInDurableObject<CMO, void>(cmoStub, async (_inst, state) => {
      const rows = state.storage.sql
        .exec("SELECT version, theme, status, generated_by FROM strategic_path")
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        version: 1, theme: "developer-first community-led growth",
        status: "proposed", generated_by: "hog",
      });
    });
  });

  it("monotonically increments version on subsequent calls", async () => {
    const userId = "hog-gsp-2";

    const cmoStub = env.CMO.getByName(transportName(userId));
    await runInDurableObject<CMO, void>(cmoStub, async (_inst, state) => applyCmoSchema(state.storage.sql));

    const hogStub = env.HOG.get(env.HOG.idFromName(userId));
    await runInDurableObject<HoG, void>(hogStub, async (_inst, state) => applyHogSchema(state.storage.sql));

    await runInDurableObject<HoG, void>(hogStub, async (instance) => {
      const tool = instance.getTools().generate_strategic_path!;
      for (let i = 1; i <= 3; i++) {
        const parsed = (tool.inputSchema as z.ZodTypeAny).parse({
          context: "{}",
          _dryRunNarrative: { theme: `v${i}`, narrative: {} },
        });
        const res = await tool.execute!(parsed, {
          experimental_context: { env: instance.bindings, userId },
        } as never);
        expect((res as { version: number }).version).toBe(i);
      }
    });
  });

  it("smoke: generate_strategic_path registered in getTools()", async () => {
    const userId = "hog-gsp-3";
    const stub = env.HOG.get(env.HOG.idFromName(userId));
    await runInDurableObject<HoG, void>(stub, async (instance) => {
      expect(Object.keys(instance.getTools())).toContain("generate_strategic_path");
    });
  });
});
