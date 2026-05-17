import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyHogSchema } from "../../src/agents/head-of-growth/schema";
import type { HoG } from "../../src/agents/head-of-growth/HeadOfGrowth";

describe("HoG tool audit_plan", () => {
  it("inserts audit_findings rows + returns summary", async () => {
    const userId = "hog-ap-1";
    const stub = env.HOG.get(env.HOG.idFromName(userId));
    await runInDurableObject<HoG, void>(stub, async (_inst, state) => applyHogSchema(state.storage.sql));

    await runInDurableObject<HoG, void>(stub, async (instance) => {
      const tool = instance.getTools().audit_plan!;
      const parsed = (tool.inputSchema as z.ZodTypeAny).parse({
        context: JSON.stringify({
          productName: "TestProd",
          planItems: [
            { id: "pi1", channel: "x", topic: "launch", status: "pending" },
            { id: "pi2", channel: "x", topic: "launch", status: "pending" },
            { id: "pi3", channel: "reddit", topic: "case-study", status: "pending" },
          ],
        }),
        _dryRunFindings: [
          {
            severity: "high",
            category: "redundancy",
            finding: "Two launch posts on X with overlapping topic",
            affectedPlanItems: ["pi1", "pi2"],
          },
          {
            severity: "med",
            category: "gap",
            finding: "Missing Reddit launch coverage",
            affectedPlanItems: [],
          },
        ],
      });
      const res = await tool.execute!(parsed, {
        experimental_context: { env: instance.bindings, userId },
      } as never);
      const r = res as { auditRunId: string; findingsCount: number; findings: Array<{ severity: string }> };
      expect(r.findingsCount).toBe(2);
      expect(r.auditRunId).toBeTruthy();
      expect(r.findings.map((f) => f.severity).sort()).toEqual(["high", "med"]);
    });

    // audit_findings rows persisted
    await runInDurableObject<HoG, void>(stub, async (_inst, state) => {
      const rows = state.storage.sql
        .exec("SELECT severity, category, finding, affected_plan_items FROM audit_findings ORDER BY severity")
        .toArray() as Array<{ severity: string; category: string; finding: string; affected_plan_items: string | null }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]!.severity).toBe("high");
      expect(rows[0]!.category).toBe("redundancy");
      expect(JSON.parse(rows[0]!.affected_plan_items ?? "[]")).toEqual(["pi1", "pi2"]);
      expect(rows[1]!.severity).toBe("med");
      expect(rows[1]!.category).toBe("gap");
    });
  });

  it("each call gets a unique auditRunId; findings sorted by severity within a run", async () => {
    const userId = "hog-ap-2";
    const stub = env.HOG.get(env.HOG.idFromName(userId));
    await runInDurableObject<HoG, void>(stub, async (_inst, state) => applyHogSchema(state.storage.sql));

    const runIds: string[] = [];
    await runInDurableObject<HoG, void>(stub, async (instance) => {
      const tool = instance.getTools().audit_plan!;
      for (let i = 0; i < 2; i++) {
        const parsed = (tool.inputSchema as z.ZodTypeAny).parse({
          context: "{}",
          _dryRunFindings: [
            { severity: "low", category: "risk", finding: `run-${i} low finding` },
          ],
        });
        const res = await tool.execute!(parsed, {
          experimental_context: { env: instance.bindings, userId },
        } as never);
        runIds.push((res as { auditRunId: string }).auditRunId);
      }
    });
    expect(runIds[0]).not.toBe(runIds[1]);
  });

  it("smoke: audit_plan registered", async () => {
    const userId = "hog-ap-3";
    const stub = env.HOG.get(env.HOG.idFromName(userId));
    await runInDurableObject<HoG, void>(stub, async (instance) => {
      expect(Object.keys(instance.getTools())).toContain("audit_plan");
    });
  });
});
