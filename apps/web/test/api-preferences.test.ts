/**
 * `/api/preferences` route tests.
 *
 * Like `mcp-token.test.ts` and `oauth-state.test.ts`, the route handler
 * itself can't mount in vitest without a Cloudflare context (it calls
 * `getCloudflareContext()` to obtain the D1 binding). We exercise the
 * validation logic directly here — particularly the theme field narrowing
 * that runs before any DB access.
 *
 * End-to-end coverage (session gate, D1 read/upsert, and response shape)
 * happens via the manual smoke test noted in the 2.3 task notes.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Inline the theme validation helper so we can test it without needing
// the Cloudflare Workers runtime. The same logic lives in the PATCH handler.
// ---------------------------------------------------------------------------

type Theme = "light" | "dark";

function isValidTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function validatePatchBody(raw: unknown):
  | { ok: true; body: Partial<{ timezone: string; theme: Theme }> }
  | { ok: false; error: string; status: number } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "invalid_json", status: 400 };
  }

  const obj = raw as Record<string, unknown>;

  if (obj.theme !== undefined && !isValidTheme(obj.theme)) {
    return { ok: false, error: "invalid_theme", status: 400 };
  }

  const body: Partial<{ timezone: string; theme: Theme }> = {};
  if (typeof obj.timezone === "string") body.timezone = obj.timezone;
  if (isValidTheme(obj.theme)) body.theme = obj.theme;

  return { ok: true, body };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/api/preferences — validation logic", () => {
  it("accepts a valid theme: dark", () => {
    const result = validatePatchBody({ theme: "dark" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.theme).toBe("dark");
  });

  it("accepts a valid theme: light", () => {
    const result = validatePatchBody({ theme: "light" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.theme).toBe("light");
  });

  it("accepts timezone without theme", () => {
    const result = validatePatchBody({ timezone: "America/New_York" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.timezone).toBe("America/New_York");
      expect(result.body.theme).toBeUndefined();
    }
  });

  it("accepts both timezone and theme together", () => {
    const result = validatePatchBody({ timezone: "Europe/London", theme: "light" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.timezone).toBe("Europe/London");
      expect(result.body.theme).toBe("light");
    }
  });

  it("rejects an invalid theme value (rainbow)", () => {
    const result = validatePatchBody({ theme: "rainbow" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_theme");
      expect(result.status).toBe(400);
    }
  });

  it("rejects an invalid theme value (empty string)", () => {
    const result = validatePatchBody({ theme: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("accepts an empty patch body (no-op update)", () => {
    const result = validatePatchBody({});
    expect(result.ok).toBe(true);
  });
});
