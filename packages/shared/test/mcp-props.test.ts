import { describe, it, expect } from "vitest";
import { assertMcpProps, ROLE_REGISTRY, isValidRole, mcpServerName } from "../src";

describe("mcp-props", () => {
  it("parses valid props", () => {
    const props = assertMcpProps({ userId: "u1", caller: "cmo" });
    expect(props.userId).toBe("u1");
    expect(props.caller).toBe("cmo");
  });

  it("rejects invalid caller", () => {
    expect(() => assertMcpProps({ userId: "u1", caller: "alien" })).toThrow();
  });
});

describe("role-registry", () => {
  it("CMO + HoG + SMM are present and default-active", () => {
    expect(ROLE_REGISTRY.cmo.defaultActive).toBe(true);
    expect(ROLE_REGISTRY["head-of-growth"].defaultActive).toBe(true);
    expect(ROLE_REGISTRY["social-media-manager"].defaultActive).toBe(true);
  });

  it("isValidRole guards type", () => {
    expect(isValidRole("cmo")).toBe(true);
    expect(isValidRole("nope")).toBe(false);
  });

  it("mcpServerName namespaces per-tenant", () => {
    expect(mcpServerName("cmo", "user-abc")).toBe("cmo-user-abc");
  });
});
