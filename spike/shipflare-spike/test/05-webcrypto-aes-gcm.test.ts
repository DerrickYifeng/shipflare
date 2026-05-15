import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { encrypt, decrypt, generateKey } from "../src/spikes/05-webcrypto-aes-gcm";

// Spike #5 — auto-tests for WebCrypto AES-GCM round-trip.
//
// Validates the WebCrypto path that will replace the Node `crypto` based
// src/lib/auth/account-encryption.ts in Phase 1.

describe("Spike #5: WebCrypto AES-GCM", () => {
  it("round-trips 100 random tokens", async () => {
    const key = await generateKey();
    for (let i = 0; i < 100; i++) {
      const random = `${crypto.randomUUID()}-${Math.random()}`;
      const ct = await encrypt(random, key);
      const dec = await decrypt(ct, key);
      expect(dec).toBe(random);
    }
  });

  it("different IV produces different ciphertext for same plaintext", async () => {
    const key = await generateKey();
    const a = await encrypt("same-input", key);
    const b = await encrypt("same-input", key);
    expect(a).not.toBe(b);
  });

  it("wrong key fails to decrypt", async () => {
    const k1 = await generateKey();
    const k2 = await generateKey();
    const ct = await encrypt("secret", k1);
    await expect(decrypt(ct, k2)).rejects.toThrow();
  });

  it("handler returns all ok=true for sample tokens", async () => {
    const res = await SELF.fetch("https://example.com/spike/05");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      allOk: boolean;
      results: Array<{ ok: boolean }>;
    };
    expect(body.allOk).toBe(true);
    expect(body.results.every((r) => r.ok)).toBe(true);
  });

  it("handles 1-byte and empty string plaintexts", async () => {
    const key = await generateKey();
    expect(await decrypt(await encrypt("", key), key)).toBe("");
    expect(await decrypt(await encrypt("a", key), key)).toBe("a");
  });
});
