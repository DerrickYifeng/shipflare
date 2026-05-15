import { describe, it, expect } from "vitest";
import { encrypt, decrypt, generateKey } from "../src";

describe("aes-gcm", () => {
  it("round-trips 100 random tokens", async () => {
    const key = await generateKey();
    for (let i = 0; i < 100; i++) {
      const pt = `token-${i}-${Math.random()}-${crypto.randomUUID()}`;
      const ct = await encrypt(pt, key);
      const dec = await decrypt(ct, key);
      expect(dec).toBe(pt);
    }
  });

  it("different IV yields different ciphertext for same plaintext", async () => {
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

  it("handles empty and single-byte plaintexts", async () => {
    const key = await generateKey();
    expect(await decrypt(await encrypt("", key), key)).toBe("");
    expect(await decrypt(await encrypt("a", key), key)).toBe("a");
  });

  it("handles multi-byte UTF-8", async () => {
    const key = await generateKey();
    const pt = "lock 🔐 with ~!@#$%^&*() and 日本語";
    expect(await decrypt(await encrypt(pt, key), key)).toBe(pt);
  });

  it("rejects ciphertext shorter than IV + tag", async () => {
    const key = await generateKey();
    await expect(decrypt("AAAAAA", key)).rejects.toThrow(/too short/);
  });

  it("generateKey returns 32 bytes base64 (44 chars including padding)", async () => {
    const k = await generateKey();
    // 32 bytes → 44 chars of base64 with one `=` padding
    expect(k).toHaveLength(44);
    expect(k.endsWith("=")).toBe(true);
  });

  it("encrypt with wrong-length key throws clear error", async () => {
    const shortKey = btoa("only-16-bytes-xx"); // 16 bytes
    await expect(encrypt("anything", shortKey)).rejects.toThrow(/must be 32 bytes/);
  });
});
