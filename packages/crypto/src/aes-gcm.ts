/**
 * WebCrypto AES-256-GCM envelope helper.
 *
 * Replaces the Node `crypto` implementation at src/lib/encryption/index.ts
 * (which uses a 16-byte IV + `iv:tag:ct` hex envelope). The new envelope is
 * `IV (12 bytes) || ciphertext+tag`, base64 encoded — a single string.
 *
 * Phase 0 spike #5 validated:
 * - 100 random round-trips
 * - Different IV per encrypt() call
 * - Wrong key fails with OperationError
 * - Edge cases: empty string, 1-byte plaintext, multi-byte UTF-8
 *
 * Phase 0 spike #5 finding: no transitional decoder for the legacy hex format
 * is shipped, since ShipFlare has no production users yet.
 */

const IV_BYTES = 12; // NIST SP 800-38D recommended size for AES-GCM
const KEY_BYTES = 32; // AES-256

// Allocate Uint8Array views over fresh ArrayBuffers (not ArrayBufferLike) so
// the types satisfy WebCrypto's BufferSource constraint under strict TS.
function freshBytes(length: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(length));
}

function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = freshBytes(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function b64encode(bytes: Uint8Array): string {
  // String.fromCharCode(...bytes) is fine for OAuth-token-sized inputs (<200 bytes).
  // For multi-KB inputs this would hit the spread argument limit; if Phase 2 ever
  // reuses this helper for larger payloads, switch to chunked encoding.
  return btoa(String.fromCharCode(...bytes));
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const raw = b64decode(keyBase64);
  if (raw.length !== KEY_BYTES) {
    throw new Error(`AES-GCM key must be ${KEY_BYTES} bytes (got ${raw.length})`);
  }
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encrypt(plaintext: string, keyBase64: string): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(freshBytes(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  const ptBytes = freshBytes(encoded.length);
  ptBytes.set(encoded);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, ptBytes),
  );
  const out = freshBytes(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64encode(out);
}

export async function decrypt(encoded: string, keyBase64: string): Promise<string> {
  const key = await importKey(keyBase64);
  const bytes = b64decode(encoded);
  // 12B IV + 16B GCM tag → minimum 28 bytes of ciphertext
  if (bytes.length < IV_BYTES + 16) {
    throw new Error("ciphertext too short to be a valid AES-GCM envelope");
  }
  const iv = freshBytes(IV_BYTES);
  iv.set(bytes.subarray(0, IV_BYTES));
  const ct = freshBytes(bytes.length - IV_BYTES);
  ct.set(bytes.subarray(IV_BYTES));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

export async function generateKey(): Promise<string> {
  const raw = crypto.getRandomValues(freshBytes(KEY_BYTES));
  return b64encode(raw);
}
