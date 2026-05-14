import type { Env } from "../index";

// Test-only key. Real production key comes from wrangler secret (CHANNEL_ENC_KEY).
// 32 zero bytes base64-encoded = AES-256 key. NEVER ship this value.
const KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

// AES-GCM IV size. 12 bytes is the NIST SP 800-38D recommendation and what
// every mainstream lib (libsodium, AWS Encryption SDK, GCP Tink) uses.
// Some older code uses 16 — don't.
const IV_BYTES = 12;

// Note: we are NOT using AAD (additional authenticated data) in this helper.
// AAD would be useful in Phase 1 if we want to bind ciphertext to a row id
// (so a swapped ciphertext from another row fails to decrypt), but it would
// require the existing src/lib/auth/account-encryption.ts callers to supply
// the AAD on read, which they currently don't. Adding AAD is an opt-in
// production-helper enhancement, deferred.

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const raw = b64decode(keyBase64);
  if (raw.length !== 32) {
    throw new Error(`AES-GCM key must be 32 bytes (got ${raw.length})`);
  }
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encrypt(plaintext: string, keyBase64 = KEY_B64): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64encode(out);
}

export async function decrypt(encoded: string, keyBase64 = KEY_B64): Promise<string> {
  const key = await importKey(keyBase64);
  const bytes = b64decode(encoded);
  // Minimum ciphertext = 12B IV + 16B GCM auth tag = 28B. Anything shorter
  // can't possibly be valid AES-GCM output.
  if (bytes.length < IV_BYTES + 16) throw new Error("ciphertext too short");
  const iv = bytes.slice(0, IV_BYTES);
  const ct = bytes.slice(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

export async function generateKey(): Promise<string> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return b64encode(raw);
}

export default async function handler(_req: Request, _env: Env): Promise<Response> {
  // Sample tokens of varying shapes to round-trip
  const samples = [
    "ghp_short_token_example",
    "xoxb-abcdefghij-12345-67890-abcdef",
    "very long token with special chars 🔐 ~!@#$%^&*()",
    "",
    "a", // 1-byte edge case
  ];
  const results: Array<{ original: string; ok: boolean; ctLength: number }> = [];
  for (const s of samples) {
    const enc = await encrypt(s);
    const dec = await decrypt(enc);
    results.push({
      original: s.slice(0, 16) + (s.length > 16 ? `... (${s.length} chars)` : ""),
      ok: s === dec,
      ctLength: enc.length,
    });
  }
  return Response.json({ results, allOk: results.every((r) => r.ok) });
}
