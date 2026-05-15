/**
 * `oauth-state.ts` unit tests.
 *
 * Like `mcp-token.test.ts`, the route handlers themselves can't mount in
 * vitest without a Cloudflare context. We exercise the pure helpers
 * directly here — sign/verify round-trip, PKCE generation properties,
 * state nonce shape. End-to-end OAuth coverage happens via the manual
 * smoke test in S8.A's task notes.
 */

import { describe, expect, it } from "vitest";
import {
  signOAuthState,
  verifyOAuthState,
  generatePkcePair,
  generateState,
} from "../src/lib/oauth-state";

describe("oauth-state", () => {
  const secret = "test-secret-32-bytes-aaaaaaaaaaaaaaaa";

  it("signs + verifies state payload round-trip (with PKCE verifier)", async () => {
    const token = await signOAuthState(
      {
        state: "abc",
        codeVerifier: "verifier",
        platform: "x",
        userId: "u1",
      },
      secret,
    );
    const payload = await verifyOAuthState(token, secret);
    expect(payload.state).toBe("abc");
    expect(payload.codeVerifier).toBe("verifier");
    expect(payload.platform).toBe("x");
    expect(payload.userId).toBe("u1");
  });

  it("round-trips Reddit payload (no PKCE verifier)", async () => {
    const token = await signOAuthState(
      { state: "xyz", platform: "reddit", userId: "u2" },
      secret,
    );
    const payload = await verifyOAuthState(token, secret);
    expect(payload.state).toBe("xyz");
    expect(payload.codeVerifier).toBeUndefined();
    expect(payload.platform).toBe("reddit");
    expect(payload.userId).toBe("u2");
  });

  it("rejects a state cookie signed with a different secret", async () => {
    const token = await signOAuthState(
      { state: "abc", platform: "x", userId: "u1" },
      secret,
    );
    await expect(verifyOAuthState(token, "wrong-secret")).rejects.toThrow(
      /invalid signature/,
    );
  });

  it("generatePkcePair returns valid PKCE pair (SHA256 S256 challenge)", async () => {
    const { verifier, challenge } = await generatePkcePair();
    // RFC 7636 mandates verifier length 43–128 chars. Our 32-byte input
    // base64url-encodes to 43 chars (no padding).
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    // SHA-256 → 32 bytes → 43 chars base64url (no padding).
    expect(challenge.length).toBe(43);
    expect(verifier).not.toBe(challenge);
    // base64url alphabet: no `=` padding, no `+` / `/`.
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generatePkcePair produces different pairs on each call", async () => {
    const p1 = await generatePkcePair();
    const p2 = await generatePkcePair();
    expect(p1.verifier).not.toBe(p2.verifier);
    expect(p1.challenge).not.toBe(p2.challenge);
  });

  it("generateState returns a base64url-safe nonce", () => {
    const state = generateState();
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    // 16 bytes → 22 chars base64url (no padding).
    expect(state.length).toBeGreaterThanOrEqual(20);
    expect(state.length).toBeLessThanOrEqual(24);
  });

  it("generateState produces different nonces on each call", () => {
    const s1 = generateState();
    const s2 = generateState();
    expect(s1).not.toBe(s2);
  });
});
