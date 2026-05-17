import { describe, it, expect } from "vitest";
import {
  runSkill,
  parseFrontmatter,
  substituteArguments,
} from "../src/runner";

describe("parseFrontmatter", () => {
  it("returns defaults when no frontmatter is present", () => {
    const { frontmatter, body } = parseFrontmatter("just a body, no fm");
    expect(frontmatter.model).toBe("claude-sonnet-4-6");
    expect(frontmatter.maxTokens).toBe(2048);
    expect(frontmatter.system).toBeUndefined();
    expect(body).toBe("just a body, no fm");
  });

  it("parses model + maxTokens + system from YAML", () => {
    const md = [
      "---",
      "name: example",
      "model: claude-haiku-4-5",
      "maxTokens: 256",
      "system: short directive",
      "---",
      "body content",
    ].join("\n");
    const { frontmatter, body } = parseFrontmatter(md);
    expect(frontmatter.model).toBe("claude-haiku-4-5");
    expect(frontmatter.maxTokens).toBe(256);
    expect(frontmatter.system).toBe("short directive");
    expect(body).toBe("body content");
  });

  it("falls back to default maxTokens on invalid numeric value", () => {
    const md = ["---", "maxTokens: notanumber", "---", "body"].join("\n");
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter.maxTokens).toBe(2048);
  });
});

describe("substituteArguments", () => {
  it("replaces a string placeholder", () => {
    expect(substituteArguments("hello {name}", { name: "world" })).toBe(
      "hello world",
    );
  });

  it("replaces all occurrences of the same key", () => {
    expect(substituteArguments("{x}+{x}", { x: "1" })).toBe("1+1");
  });

  it("JSON.stringifies non-string values", () => {
    const out = substituteArguments("params: {p}", { p: { a: 1, b: [2] } });
    expect(out).toBe('params: {"a":1,"b":[2]}');
  });

  it("leaves unknown placeholders intact", () => {
    expect(substituteArguments("{a} {b}", { a: "x" })).toBe("x {b}");
  });
});

describe("runSkill", () => {
  it("throws a helpful error on unknown skill name", async () => {
    await expect(
      runSkill({ name: "nonexistent-skill", args: {}, env: { ANTHROPIC_API_KEY: "" } }),
    ).rejects.toThrow(/Unknown skill/);
  });
});
