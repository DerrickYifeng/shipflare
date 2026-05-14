import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// Spike #4 — auto-tests for Better Auth + Drizzle + D1.
//
// Pre-req: the migration in migrations/001_better_auth.sql must have been
// applied locally before vitest runs:
//   pnpm wrangler d1 execute shipflare-spike --local --file migrations/001_better_auth.sql
// Otherwise the auth handler will crash on missing tables when getSession
// hits its internal queries.
//
// Full GitHub OAuth dance (sign-in → callback → cookie → user row) is
// deferred to manual validation; documented in RESULTS.md.

interface SessionResponse {
  session: unknown;
}

describe("Spike #4: Better Auth + Drizzle + D1", () => {
  it("getSession returns null without cookie", async () => {
    const res = await SELF.fetch("https://example.com/spike/04/session");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionResponse;
    expect(body.session).toBeNull();
  }, 30_000);

  it("auth handler bootstraps without crashing on /api/auth/get-session", async () => {
    // No cookie → Better Auth should respond cleanly (200 with null session or
    // 401-class), NOT a 5xx that would mean the adapter / D1 wiring crashed.
    const res = await SELF.fetch("https://example.com/api/auth/get-session");
    expect(res.status).toBeLessThan(500);
  }, 30_000);

  it("/spike/04 returns the manual-OAuth instructions payload", async () => {
    const res = await SELF.fetch("https://example.com/spike/04");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      note: string;
      probeEndpoint: string;
      manualOAuth: { signIn: string; callback: string };
    };
    expect(body.probeEndpoint).toBe("/spike/04/session");
    expect(body.manualOAuth.signIn).toBe(
      "/api/auth/sign-in/social?provider=github",
    );
  }, 30_000);
});
