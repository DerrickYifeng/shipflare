/**
 * `/api/product` route tests.
 *
 * Like `api-preferences.test.ts`, the route handler can't mount in vitest
 * without a Cloudflare context. We exercise the PATCH validation logic
 * directly by inlining the same narrowing function here.
 *
 * End-to-end coverage (session gate, D1 read/upsert, and response shape)
 * is handled via the manual smoke test in the task notes.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Inline validation helper — mirrors the PATCH handler's narrowing logic.
// ---------------------------------------------------------------------------

type ProductState = "mvp" | "launching" | "launched";

const PRODUCT_STATES: readonly ProductState[] = [
  "mvp",
  "launching",
  "launched",
];

interface ValidatedPatch {
  name?: string | null;
  description?: string | null;
  valueProp?: string | null;
  url?: string | null;
  keywords?: string[];
  state?: ProductState;
  launchDate?: Date | null;
}

type ValidationResult =
  | { ok: true; body: ValidatedPatch }
  | { ok: false; error: string; status: number };

function validatePatchBody(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "invalid_body", status: 400 };
  }
  const body = raw as Record<string, unknown>;

  const patch: ValidatedPatch = {};

  if ("name" in body) {
    if (body.name !== null && typeof body.name !== "string") {
      return { ok: false, error: "invalid_name", status: 400 };
    }
    patch.name = body.name as string | null;
  }

  if ("description" in body) {
    if (body.description !== null && typeof body.description !== "string") {
      return { ok: false, error: "invalid_description", status: 400 };
    }
    patch.description = body.description as string | null;
  }

  if ("valueProp" in body) {
    if (body.valueProp !== null && typeof body.valueProp !== "string") {
      return { ok: false, error: "invalid_valueProp", status: 400 };
    }
    patch.valueProp = body.valueProp as string | null;
  }

  if ("url" in body) {
    if (body.url !== null && typeof body.url !== "string") {
      return { ok: false, error: "invalid_url", status: 400 };
    }
    patch.url = body.url as string | null;
  }

  if ("keywords" in body) {
    if (
      !Array.isArray(body.keywords) ||
      !body.keywords.every((k) => typeof k === "string")
    ) {
      return { ok: false, error: "invalid_keywords", status: 400 };
    }
    patch.keywords = body.keywords as string[];
  }

  if ("state" in body) {
    if (
      typeof body.state !== "string" ||
      !PRODUCT_STATES.includes(body.state as ProductState)
    ) {
      return { ok: false, error: "invalid_state", status: 400 };
    }
    patch.state = body.state as ProductState;
  }

  if ("launchDate" in body) {
    if (body.launchDate === null) {
      patch.launchDate = null;
    } else if (typeof body.launchDate === "number") {
      patch.launchDate = new Date(body.launchDate * 1000);
    } else {
      return { ok: false, error: "invalid_launchDate", status: 400 };
    }
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "empty_patch", status: 400 };
  }

  return { ok: true, body: patch };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/api/product — PATCH validation logic", () => {
  // ── valid payloads ────────────────────────────────────────────────────────

  it("accepts a valid name string", () => {
    const result = validatePatchBody({ name: "My SaaS" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.name).toBe("My SaaS");
  });

  it("accepts name: null (deliberate clear)", () => {
    const result = validatePatchBody({ name: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.name).toBeNull();
  });

  it("accepts a valid state: launched", () => {
    const result = validatePatchBody({ state: "launched" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.state).toBe("launched");
  });

  it("accepts all three valid states", () => {
    for (const s of PRODUCT_STATES) {
      const result = validatePatchBody({ state: s });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.body.state).toBe(s);
    }
  });

  it("accepts keywords as string array", () => {
    const result = validatePatchBody({ keywords: ["saas", "b2b"] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.keywords).toEqual(["saas", "b2b"]);
  });

  it("accepts empty keywords array", () => {
    const result = validatePatchBody({ keywords: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.keywords).toEqual([]);
  });

  it("accepts launchDate as Unix seconds number", () => {
    const ts = 1_700_000_000;
    const result = validatePatchBody({ launchDate: ts });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.launchDate).toBeInstanceOf(Date);
      expect(result.body.launchDate?.getTime()).toBe(ts * 1000);
    }
  });

  it("accepts launchDate: null (clear the date)", () => {
    const result = validatePatchBody({ launchDate: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.launchDate).toBeNull();
  });

  it("accepts a multi-field patch", () => {
    const result = validatePatchBody({
      name: "Acme",
      state: "launching",
      keywords: ["growth"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.name).toBe("Acme");
      expect(result.body.state).toBe("launching");
      expect(result.body.keywords).toEqual(["growth"]);
    }
  });

  // ── invalid state ─────────────────────────────────────────────────────────

  it("rejects an unknown state value", () => {
    const result = validatePatchBody({ state: "ascending" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_state");
      expect(result.status).toBe(400);
    }
  });

  it("rejects state as empty string", () => {
    const result = validatePatchBody({ state: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_state");
  });

  it("rejects state as number", () => {
    const result = validatePatchBody({ state: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_state");
  });

  // Legacy enum values (pre-migration 006_onboarding_schema) must be rejected.
  it.each(["draft", "pre-launch", "growing"])(
    "rejects legacy state value: %s",
    (legacy) => {
      const result = validatePatchBody({ state: legacy });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("invalid_state");
    },
  );

  // ── invalid name ──────────────────────────────────────────────────────────

  it("rejects name as number", () => {
    const result = validatePatchBody({ name: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_name");
      expect(result.status).toBe(400);
    }
  });

  it("rejects name as boolean", () => {
    const result = validatePatchBody({ name: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_name");
  });

  // ── invalid keywords ──────────────────────────────────────────────────────

  it("rejects keywords containing a non-string element", () => {
    const result = validatePatchBody({ keywords: ["valid", 42] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_keywords");
      expect(result.status).toBe(400);
    }
  });

  it("rejects keywords as a plain string (not array)", () => {
    const result = validatePatchBody({ keywords: "saas" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_keywords");
  });

  // ── invalid launchDate ────────────────────────────────────────────────────

  it("rejects launchDate as a string", () => {
    const result = validatePatchBody({ launchDate: "2024-01-01" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_launchDate");
      expect(result.status).toBe(400);
    }
  });

  it("rejects launchDate as an object", () => {
    const result = validatePatchBody({ launchDate: { ts: 123 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_launchDate");
  });

  // ── empty / non-object body ───────────────────────────────────────────────

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

  it("rejects an array body (treated as empty object — no known fields)", () => {
    // Arrays pass the typeof/null guard but have no known patch keys,
    // so they fall through to empty_patch rather than invalid_body.
    const result = validatePatchBody([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("empty_patch");
  });

  // ── protected fields are ignored (not present in patch output) ────────────

  it("ignores launchedAt if present in body (not a patchable field)", () => {
    // launchedAt is not in the patch spec — passing it results in empty_patch
    const result = validatePatchBody({ launchedAt: 123 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("empty_patch");
  });

  it("ignores userId if present in body (not a patchable field)", () => {
    const result = validatePatchBody({ userId: "hacker" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("empty_patch");
  });
});
