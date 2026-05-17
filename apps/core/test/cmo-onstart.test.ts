import { describe, expect, it } from "vitest";
import { ROLE_REGISTRY, mcpServerName } from "@shipflare/shared";

/**
 * Post-Task-5.1b smoke checks for the CMO startup contract.
 *
 * The legacy `connectEmployees()` loop was retired alongside the McpAgent
 * rewrite: CMO no longer dials peers via `addMcpServer`, peers are reached
 * exclusively through the `consult` tool. The `roster` SQLite table was
 * dropped from `applyCmoSchema`. What survives here is the ROLE_REGISTRY
 * binding-name contract (still relied on by `handleInternalRequest` in
 * `apps/core/src/index.ts`) and the per-tenant DO-name helper used by
 * the cron fan-out.
 */

describe("CMO ROLE_REGISTRY contract", () => {
  it("namespaced server name matches mcpServerName(role, userId)", () => {
    // Pure helper test — guards the per-tenant DO-name invariant: the cron
    // fan-out and any future addMcpServer-shaped re-entry MUST key DO
    // instances by `${role}-${userId}` to keep tenants isolated.
    const name = mcpServerName("social-media-manager", "user-abc-123");
    expect(name).toBe("social-media-manager-user-abc-123");
  });

  it("ROLE_REGISTRY entries map to env-binding names", () => {
    // The binding name is what `handleInternalRequest` reads from `env`
    // to look up the DurableObjectNamespace for `/internal/*` forwarding.
    // Mismatch here ⇒ 503 in production. Pin the contract.
    expect(ROLE_REGISTRY["head-of-growth"].binding).toBe("HOG");
    expect(ROLE_REGISTRY["social-media-manager"].binding).toBe("SMM");
    expect(ROLE_REGISTRY["cmo"].binding).toBe("CMO");
  });
});
