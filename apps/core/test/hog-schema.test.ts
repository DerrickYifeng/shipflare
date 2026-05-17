import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyHogSchema } from "../src/agents/head-of-growth/schema";
import type { HoG } from "../src/agents/head-of-growth/HeadOfGrowth";

describe("applyHogSchema", () => {
  it("creates planning_chat + proposal_drafts + audit_findings idempotently", async () => {
    const id = env.HOG.idFromName("hog-schema-test");
    await runInDurableObject<HoG, void>(env.HOG.get(id), async (_inst, state) => {
      applyHogSchema(state.storage.sql);
      applyHogSchema(state.storage.sql);

      const tables = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .toArray()
        .map((r) => r.name);

      expect(tables).toContain("planning_chat");
      expect(tables).toContain("proposal_drafts");
      expect(tables).toContain("audit_findings");
    });
  });

  it("proposal_drafts.version UNIQUE enforced", async () => {
    const id = env.HOG.idFromName("hog-schema-version-unique");
    await runInDurableObject<HoG, void>(env.HOG.get(id), async (_inst, state) => {
      applyHogSchema(state.storage.sql);
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO proposal_drafts (id, version, theme, narrative_json, generated_at)
         VALUES (?, ?, ?, ?, ?)`,
        "p1", 1, "wedge", "{}", now,
      );
      expect(() =>
        state.storage.sql.exec(
          `INSERT INTO proposal_drafts (id, version, theme, narrative_json, generated_at)
           VALUES (?, ?, ?, ?, ?)`,
          "p2", 1, "wedge", "{}", now,
        ),
      ).toThrow();
    });
  });
});
