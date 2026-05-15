/**
 * `/api/preferences` route tests.
 *
 * Like `mcp-token.test.ts` and `oauth-state.test.ts`, the route handler
 * itself can't mount in vitest without a Cloudflare context (it calls
 * `getCloudflareContext()` to obtain the D1 binding). We exercise the
 * validation logic directly here — particularly the field narrowing
 * that runs before any DB access.
 *
 * End-to-end coverage (session gate, D1 read/upsert, and response shape)
 * happens via the manual smoke test noted in the 2.3 task notes.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Inline the validation helper so we can test it without needing the
// Cloudflare Workers runtime. The logic mirrors the PATCH handler.
// ---------------------------------------------------------------------------

type Theme = "light" | "dark";

interface ValidatedPatch {
  timezone?: string;
  theme?: Theme;
}

type ValidationResult =
  | { ok: true; body: ValidatedPatch }
  | { ok: false; error: string; status: number };

function validatePatchBody(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "invalid_body", status: 400 };
  }
  const body = raw as Record<string, unknown>;

  let nextTimezone: string | undefined;
  if (body.timezone !== undefined) {
    if (typeof body.timezone !== "string" || body.timezone.length === 0) {
      return { ok: false, error: "invalid_timezone", status: 400 };
    }
    nextTimezone = body.timezone;
  }

  let nextTheme: Theme | undefined;
  if (body.theme !== undefined) {
    if (body.theme !== "light" && body.theme !== "dark") {
      return { ok: false, error: "invalid_theme", status: 400 };
    }
    nextTheme = body.theme;
  }

  if (nextTimezone === undefined && nextTheme === undefined) {
    return { ok: false, error: "empty_patch", status: 400 };
  }

  const out: ValidatedPatch = {};
  if (nextTimezone !== undefined) out.timezone = nextTimezone;
  if (nextTheme !== undefined) out.theme = nextTheme;
  return { ok: true, body: out };
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
    const result = validatePatchBody({
      timezone: "Europe/London",
      theme: "light",
    });
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
    if (!result.ok) {
      expect(result.error).toBe("invalid_theme");
      expect(result.status).toBe(400);
    }
  });

  it("rejects a non-string timezone (number)", () => {
    const result = validatePatchBody({ timezone: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_timezone");
      expect(result.status).toBe(400);
    }
  });

  it("rejects an empty-string timezone", () => {
    const result = validatePatchBody({ timezone: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_timezone");
      expect(result.status).toBe(400);
    }
  });

  it("rejects a non-string timezone (object)", () => {
    const result = validatePatchBody({ timezone: { tz: "UTC" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_timezone");
      expect(result.status).toBe(400);
    }
  });

  it("rejects an empty patch body (no fields supplied)", () => {
    const result = validatePatchBody({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("empty_patch");
      expect(result.status).toBe(400);
    }
  });

  it("rejects a non-object body (string)", () => {
    const result = validatePatchBody("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_body");
      expect(result.status).toBe(400);
    }
  });

  it("rejects a null body", () => {
    const result = validatePatchBody(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_body");
      expect(result.status).toBe(400);
    }
  });
});
