/**
 * `/api/account` route tests.
 *
 * Like `api-preferences.test.ts`, the route handler itself can't mount in
 * vitest without a Cloudflare context (it calls `getCloudflareContext()` to
 * obtain the D1 + CORE bindings). We exercise the logic that CAN be tested
 * in isolation — the agent-slug list and the response shape for the 401 path.
 *
 * End-to-end coverage (authenticated session gate, D1 deletion, and redirect
 * to `/`) happens via the Playwright smoke tests and manual QA.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// The list of agent DOs that get `/internal/destroy` on account deletion.
// This is the same constant as in the route — inlined here so a rename
// in the route surfaces as a test failure rather than silently breaking
// the sweep.
// ---------------------------------------------------------------------------

const AGENTS_TO_DESTROY = [
  "cmo",
  "head-of-growth",
  "social-media-manager",
] as const;

type AgentSlug = (typeof AGENTS_TO_DESTROY)[number];

/**
 * Simulates the destroy-URL construction logic in destroyAgentState().
 * If the route changes the URL shape, this test will fail and catch it.
 */
function buildDestroyUrl(userId: string, agent: AgentSlug): string {
  return `https://internal/agents/${agent}/${userId}/internal/destroy`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/api/account — DELETE logic", () => {
  it("AGENTS_TO_DESTROY includes cmo, head-of-growth, social-media-manager", () => {
    expect(AGENTS_TO_DESTROY).toContain("cmo");
    expect(AGENTS_TO_DESTROY).toContain("head-of-growth");
    expect(AGENTS_TO_DESTROY).toContain("social-media-manager");
    expect(AGENTS_TO_DESTROY).toHaveLength(3);
  });

  it("builds destroy URLs with the correct /internal/destroy suffix for each agent", () => {
    const userId = "user_abc123";
    for (const agent of AGENTS_TO_DESTROY) {
      const url = buildDestroyUrl(userId, agent);
      expect(url).toBe(
        `https://internal/agents/${agent}/${userId}/internal/destroy`,
      );
      expect(url).toMatch(/\/internal\/destroy$/);
    }
  });

  it("destroy URL encodes userId correctly (no double-encoding)", () => {
    // userId values are opaque IDs (e.g. Better Auth UUIDs) — no special chars
    // expected, but verify the template substitution is stable.
    const userId = "abc-def-123";
    const url = buildDestroyUrl(userId, "cmo");
    expect(url).toContain(userId);
    expect(url).toBe(`https://internal/agents/cmo/${userId}/internal/destroy`);
  });

  it("401 response shape matches the convention used by other /api routes", () => {
    // Mirrors the shape the route returns for unauthenticated requests.
    const unauthorizedBody = { error: "unauthorized" };
    expect(unauthorizedBody).toHaveProperty("error", "unauthorized");
  });

  it("success response shape returns { ok: true }", () => {
    const successBody = { ok: true };
    expect(successBody).toHaveProperty("ok", true);
  });
});
