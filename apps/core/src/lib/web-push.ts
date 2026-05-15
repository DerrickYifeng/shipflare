/**
 * Minimal Web Push (RFC 8030) client using WebCrypto.
 *
 * Scope for P2-F:
 *  - VAPID JWT (RFC 8292) signed with ES256 (ECDSA P-256 / SHA-256).
 *  - Empty-body push (TTL-only). The service worker shows a generic
 *    "Check ShipFlare" notification on receipt; the click handler
 *    navigates the user to /chat where the actual context lives.
 *  - Encrypted payload (RFC 8291 / aes128gcm) is a P2-F.2 follow-up.
 *    The plumbing here (push_subscriptions, /api/push/subscribe,
 *    sw.js, /notifications) is the heavy part — once VAPID signing
 *    is verified end-to-end, adding the encrypted payload is a
 *    contained change inside `sendWebPush` + the service worker.
 *
 * Key format expected by `sendWebPush`:
 *   publicKey  — base64url of the 65-byte uncompressed P-256 point
 *                (`0x04 || X || Y`), the standard `applicationServerKey`
 *                format used by browsers + the `web-push` npm library.
 *   privateKey — base64url of the 32-byte raw private scalar (the JWK
 *                `d` component), same format `web-push` uses.
 *
 * `generateVapidKeypair()` below produces a matching pair — run it
 * once and store the values in `wrangler secret put VAPID_PUBLIC` /
 * `VAPID_PRIVATE`.
 */

/**
 * Type alias (not interface) so it satisfies the
 * `Record<string, SqlStorageValue>` constraint on `SqlStorage.exec<T>()`
 * without a manual index signature. Interfaces in TS don't auto-satisfy
 * index signatures, type aliases do.
 */
export type PushSubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface SendWebPushResult {
  ok: boolean;
  status: number;
  /** Caller should delete this subscription (endpoint gone). */
  shouldDelete: boolean;
}

/**
 * Send a push notification to a single subscriber.
 *
 * Returns `{ ok, status, shouldDelete }`. The caller is expected to
 * persist `last_used` on success and either delete (404/410) or
 * record `last_error` on failure.
 *
 * Body is empty for P2-F — the service worker shows a fixed
 * "Check ShipFlare" message and routes the click to `/chat`.
 * Encrypted payload support arrives in P2-F.2 (see file header).
 */
export async function sendWebPush(
  subscription: PushSubscriptionRow,
  _payload: PushPayload,
  vapid: VapidConfig,
): Promise<SendWebPushResult> {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await signVapidJwt(
    audience,
    vapid.subject,
    vapid.privateKey,
    vapid.publicKey,
  );

  const headers: Record<string, string> = {
    Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
    TTL: "86400", // 24h max age — service worker only shows generic body.
    "Content-Length": "0",
  };

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers,
  });

  return {
    ok: res.ok,
    status: res.status,
    // 404 = endpoint never existed; 410 = subscription expired/unsubscribed.
    // Per RFC 8030 §7.3, both mean "stop sending to this endpoint".
    shouldDelete: res.status === 404 || res.status === 410,
  };
}

/**
 * Sign a VAPID JWT per RFC 8292.
 *
 * Header: `{ "typ": "JWT", "alg": "ES256" }`
 * Claims: `{ aud, exp, sub }` — `aud` is the push service origin,
 *         `exp` is unix seconds (12h from now is well within the
 *         RFC's 24h max), `sub` is a `mailto:` or `https://` URI
 *         identifying the application contact.
 * Sig:    ECDSA P-256 over SHA-256 of `${headerB64}.${claimsB64}`,
 *         output as raw 64-byte (r||s) IEEE-P1363 form — WebCrypto's
 *         default for `ECDSA` (NOT DER-encoded; do NOT post-process).
 */
async function signVapidJwt(
  audience: string,
  subject: string,
  privateKey: string,
  publicKey: string,
): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, // 12h
    sub: subject,
  };

  const encodedHeader = b64urlEncode(
    new TextEncoder().encode(JSON.stringify(header)),
  );
  const encodedClaims = b64urlEncode(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signingInput = `${encodedHeader}.${encodedClaims}`;

  // Import the private key as JWK. WebCrypto requires both `d` (private
  // scalar) AND `x`/`y` (public point) to round-trip an EC private key
  // through `importKey("jwk", ...)`. We derive `x` and `y` from the
  // 65-byte uncompressed `publicKey` (format: 0x04 || X(32) || Y(32)).
  const publicBytes = b64urlDecode(publicKey);
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    throw new Error(
      `VAPID publicKey must be 65-byte uncompressed P-256 (got ${publicBytes.length} bytes, first byte 0x${publicBytes[0]?.toString(16) ?? "??"})`,
    );
  }
  const x = b64urlEncode(publicBytes.slice(1, 33));
  const y = b64urlEncode(publicBytes.slice(33, 65));

  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: privateKey,
    x,
    y,
    ext: false,
  };

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${b64urlEncode(new Uint8Array(signature))}`;
}

/**
 * Helper for one-time VAPID setup: generates an ES256 P-256 keypair
 * and returns it in the same base64url format `sendWebPush` expects.
 *
 * Usage (Node REPL or a one-off script):
 *   const { publicKey, privateKey } = await generateVapidKeypair();
 *   // wrangler secret put VAPID_PUBLIC <publicKey>
 *   // wrangler secret put VAPID_PRIVATE <privateKey>
 *   // NEXT_PUBLIC_VAPID_PUBLIC=<publicKey> in apps/web/.env.local
 */
export async function generateVapidKeypair(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const keypair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  // `exportKey("jwk", ...)` returns `ArrayBuffer | JsonWebKey` in the
  // current Workers types union; the JWK branch is what we get here.
  const publicJwk = (await crypto.subtle.exportKey(
    "jwk",
    keypair.publicKey,
  )) as JsonWebKey;
  const privateJwk = (await crypto.subtle.exportKey(
    "jwk",
    keypair.privateKey,
  )) as JsonWebKey;
  if (!publicJwk.x || !publicJwk.y || !privateJwk.d) {
    throw new Error("WebCrypto returned an incomplete JWK");
  }
  const x = b64urlDecode(publicJwk.x);
  const y = b64urlDecode(publicJwk.y);
  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(x, 1);
  publicKey.set(y, 33);
  return {
    publicKey: b64urlEncode(publicKey),
    privateKey: privateJwk.d,
  };
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): Uint8Array {
  const padded =
    s.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}
