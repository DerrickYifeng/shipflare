import { describe, it, expect } from "vitest";
import { SKILL_REGISTRY, listSkills } from "../src";

describe("SKILL_REGISTRY", () => {
  it("contains all 5 Phase 1 skills plus allocating-plan-items", () => {
    expect(listSkills()).toEqual(
      expect.arrayContaining([
        "allocating-plan-items",
        "drafting-post",
        "drafting-reply",
        "judging-thread",
        "validating-draft",
        "generate-queries",
      ]),
    );
  });

  it("allocating-plan-items: has frontmatter declaring correct name", () => {
    expect(SKILL_REGISTRY["allocating-plan-items"]).toContain(
      "name: allocating-plan-items",
    );
  });

  it("allocating-plan-items: has a non-empty body (> 500 chars)", () => {
    expect(SKILL_REGISTRY["allocating-plan-items"]!.length).toBeGreaterThan(
      500,
    );
  });

  it("allocating-plan-items: contains $ARGUMENTS placeholder", () => {
    expect(SKILL_REGISTRY["allocating-plan-items"]).toContain("$ARGUMENTS");
  });

  it("each skill has frontmatter delimiters and a non-empty body", () => {
    for (const name of listSkills()) {
      const md = SKILL_REGISTRY[name];
      expect(md, `skill ${name} should be registered`).toBeDefined();
      expect(md).toMatch(/^---\n/);
      expect(md).toMatch(/\n---\n/);
      // Body length sanity: at least one substantive paragraph.
      expect(md!.split(/\n---\n/)[1]!.trim().length).toBeGreaterThan(50);
    }
  });

  it("each skill declares its own name in frontmatter", () => {
    for (const name of listSkills()) {
      const md = SKILL_REGISTRY[name]!;
      expect(md).toMatch(new RegExp(`name:\\s*${name}\\b`));
    }
  });
});
