/**
 * HS256 JWT sign / verify using WebCrypto.
 *
 * Used for:
 * - Browser → core auth: short-lived (60s default) tokens signed with
 *   MCP_JWT_SECRET. The browser obtains one via the web app's session-aware
 *   `/api/mcp-token` route and sends it in `Authorization: Bearer <jwt>` on
 *   each MCP request to `/agents/<role>/<userId>/mcp`. The core Worker
 *   verifies the signature, extracts `userId`, and uses it to pick the
 *   correct DO instance.
 * - Phase 2 external MCP exposure: longer-lived tokens signed with a
 *   separate EXTERNAL_MCP_SECRET for third-party agentic clients (Claude
 *   Desktop, Cursor, etc.).
 *
 * Algorithm: HS256 (HMAC-SHA-256). Same secret signs + verifies — symmetric.
 * If we ever expose tokens cross-tenant or to a less-trusted client, switch
 * to RS256 / ES256 (asymmetric) so the verifier can hold only the public key.
 */

/**
 * Allocate `Uint8Array` views over fresh `ArrayBuffer` (not the union
 * `ArrayBufferLike`) so the types satisfy WebCrypto's `BufferSource`
 * constraint under strict TS 5.9.
 *
 * Without this, `crypto.subtle.sign(... , uint8Array)` errors with:
 *   "Argument of type 'Uint8Array<ArrayBufferLike>' is not assignable to
 *    parameter of type 'BufferSource | undefined'"
 *
 * See packages/crypto/src/aes-gcm.ts for the same workaround.
 */
function freshBytes(length: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(length));
}

function utf8(s: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(s);
  const out = freshBytes(encoded.length);
  out.set(encoded);
  return out;
}

function b64urlEncode(bytes: Uint8Array): string {
  // String.fromCharCode(...bytes) is fine for header/payload-sized inputs
  // (typical JWT < 1KB). For larger payloads switch to chunked encoding.
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const padded =
    s.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = freshBytes(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function importKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export interface JwtPayload {
  iat: number;
  exp: number;
  [claim: string]: unknown;
}

/**
 * Sign a JWT payload with HS256.
 *
 * @param payload - Custom claims (e.g. `{ userId, role }`). `iat` and `exp`
 *   are added automatically — do not include them.
 * @param secret - HMAC secret. In production this comes from
 *   `env.MCP_JWT_SECRET` (a `wrangler secret`).
 * @param ttlSeconds - Token lifetime in seconds. Default 60s (matches
 *   browser → core flow). Use negative values in tests to produce an
 *   already-expired token.
 */
export async function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  ttlSeconds = 60,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: Record<string, unknown> = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
  };
  const encH = b64urlEncode(utf8(JSON.stringify(header)));
  const encP = b64urlEncode(utf8(JSON.stringify(fullPayload)));
  const data = `${encH}.${encP}`;
  const key = await importKey(secret, "sign");
  const sigBuf = await crypto.subtle.sign("HMAC", key, utf8(data));
  return `${data}.${b64urlEncode(new Uint8Array(sigBuf))}`;
}

/**
 * Verify a JWT and return its decoded payload.
 *
 * Throws on: malformed token, invalid signature, or expired (`exp < now`).
 * Callers must catch and surface a 401 to the client.
 */
export async function verifyJwt(
  token: string,
  secret: string,
): Promise<JwtPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("malformed jwt");
  }
  const [encH, encP, encS] = parts;
  if (!encH || !encP || !encS) {
    throw new Error("malformed jwt");
  }
  const key = await importKey(secret, "verify");
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlDecode(encS),
    utf8(`${encH}.${encP}`),
  );
  if (!ok) {
    throw new Error("invalid signature");
  }
  const payload = JSON.parse(
    new TextDecoder().decode(b64urlDecode(encP)),
  ) as Record<string, unknown>;
  const exp = payload["exp"];
  if (typeof exp !== "number") {
    throw new Error("token missing exp claim");
  }
  if (exp < Math.floor(Date.now() / 1000)) {
    throw new Error("token expired");
  }
  return payload as JwtPayload;
}
