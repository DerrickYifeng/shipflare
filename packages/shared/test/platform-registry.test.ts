import { describe, it, expect } from "vitest";
import {
  PLATFORMS,
  isValidPlatform,
  platformServerName,
} from "../src";

describe("platform-registry", () => {
  it("X + Reddit are present with the canonical bindings", () => {
    expect(PLATFORMS.x.binding).toBe("X_MCP");
    expect(PLATFORMS.reddit.binding).toBe("REDDIT_MCP");
  });

  it("isValidPlatform guards the type", () => {
    expect(isValidPlatform("x")).toBe(true);
    expect(isValidPlatform("reddit")).toBe(true);
    expect(isValidPlatform("threads")).toBe(false);
    expect(isValidPlatform("cmo")).toBe(false);
  });

  it("platformServerName namespaces per-tenant with the -mcp- infix", () => {
    expect(platformServerName("x", "user-abc")).toBe("x-mcp-user-abc");
    expect(platformServerName("reddit", "user-xyz")).toBe(
      "reddit-mcp-user-xyz",
    );
  });
});
