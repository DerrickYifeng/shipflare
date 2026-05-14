import { describe, it, expect } from "vitest";
import { SKILL_REGISTRY, listSkills } from "../src";
import { parseFrontmatter, substituteArguments } from "../src/runner";

describe("Skill contracts", () => {
  const skills = listSkills();

  it.each(skills)("%s has valid frontmatter with model + maxTokens", (name) => {
    const md = SKILL_REGISTRY[name]!;
    const { frontmatter, body } = parseFrontmatter(md);
    expect(frontmatter.model).toBeTruthy();
    expect(frontmatter.maxTokens).toBeGreaterThan(0);
    expect(body.length).toBeGreaterThan(50);
  });

  it("drafting-post placeholders are substituted", () => {
    const md = SKILL_REGISTRY["drafting-post"]!;
    const { body } = parseFrontmatter(md);
    const result = substituteArguments(body, {
      platform: "x",
      product: "ShipFlare",
      productDescription: "AI marketing team",
      voice: "casual",
      lengthHint: "≤ 280 chars",
      skill: "drafting-post",
      params: "{}",
    });
    expect(result).toContain("ShipFlare");
    expect(result).toContain("AI marketing team");
    expect(result).not.toContain("{product}");
    expect(result).not.toContain("{productDescription}");
    expect(result).not.toContain("{voice}");
    expect(result).not.toContain("{platform}");
    expect(result).not.toContain("{lengthHint}");
    expect(result).not.toContain("{skill}");
    expect(result).not.toContain("{params}");
  });

  it("drafting-reply placeholders are substituted", () => {
    const md = SKILL_REGISTRY["drafting-reply"]!;
    const { body } = parseFrontmatter(md);
    const result = substituteArguments(body, {
      product: "TestApp",
      productDescription: "desc",
      voice: "direct",
      platform: "reddit",
      lengthHint: "≤ 1000 chars",
      threadAuthor: "alice",
      threadContent: "What's the best tool for this?",
    });
    expect(result).toContain("TestApp");
    expect(result).toContain("alice");
    expect(result).toContain("What's the best tool for this?");
    expect(result).not.toContain("{product}");
    expect(result).not.toContain("{threadAuthor}");
    expect(result).not.toContain("{threadContent}");
  });

  it("judging-thread placeholders are substituted", () => {
    const md = SKILL_REGISTRY["judging-thread"]!;
    const { body } = parseFrontmatter(md);
    const result = substituteArguments(body, {
      product: "TestApp",
      productDescription: "desc",
      threads: JSON.stringify(
        [{ externalId: "x-1", content: "test" }],
        null,
        2,
      ),
    });
    expect(result).toContain("TestApp");
    expect(result).toContain("x-1");
    expect(result).not.toContain("{product}");
    expect(result).not.toContain("{threads}");
  });

  it("validating-draft placeholders are substituted", () => {
    const md = SKILL_REGISTRY["validating-draft"]!;
    const { body } = parseFrontmatter(md);
    const result = substituteArguments(body, {
      platform: "x",
      kind: "post",
      product: "TestApp",
      context: "(no thread)",
      draft: "Hello world",
    });
    expect(result).toContain("Hello world");
    expect(result).toContain("TestApp");
    expect(result).not.toContain("{draft}");
    expect(result).not.toContain("{context}");
    expect(result).not.toContain("{kind}");
  });

  it("generate-queries placeholders are substituted", () => {
    const md = SKILL_REGISTRY["generate-queries"]!;
    const { body } = parseFrontmatter(md);
    const result = substituteArguments(body, {
      product: "TestApp",
      productDescription: "desc",
      platform: "x",
      maxQueries: "5",
      context: "discover engagement opportunities",
    });
    expect(result).toContain("TestApp");
    expect(result).toContain("discover engagement opportunities");
    expect(result).not.toContain("{maxQueries}");
    expect(result).not.toContain("{product}");
    expect(result).not.toContain("{platform}");
  });
});
