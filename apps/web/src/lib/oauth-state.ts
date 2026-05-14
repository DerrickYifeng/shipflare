/**
 * OAuth state-cookie helper — signs/verifies a short-lived payload that
 * bundles the random `state` token (CSRF defense) and the PKCE
 * `code_verifier` (for X) so neither leaves the user's browser in plaintext.
 *
 * Signed via HS256 with `BETTER_AUTH_SECRET` (shared with Better Auth — both
 * sign cookies with this secret; revoking it rotates every cookie at once).
 *
 * Cookie naming convention: `oauth-state-<platform>`. Set with `HttpOnly`,
 * `SameSite=Lax`, and `Secure` when on HTTPS. Max-Age = `STATE_TTL_SECONDS`.
 *
 * State payload lives inside the JWT, not as separate cookies — this means
 * both `state` and `codeVerifier` are tamper-proof in one round-trip, and
 * the callback can verify both from a single cookie read.
 */

import { signJwt, verifyJwt } from "./jwt";

export interface OAuthStatePayload {
  /** Random nonce echoed by the IdP — defends against CSRF. */
  state: string;
  /** PKCE code_verifier (X only — Reddit omits this). */
  codeVerifier?: string;
  /** Platform tag — guards against cross-platform cookie reuse. */
  platform: "x" | "reddit";
  /** Better Auth user.id — guards against cross-user cookie reuse. */
  userId: string;
}

/**
 * 10 minutes. OAuth flows complete in seconds; a generous TTL accommodates
 * slow networks / 2FA prompts without leaving stale state cookies behind.
 */
export const STATE_TTL_SECONDS = 600;

/**
 * Sign an OAuth state payload into an HS256 JWT suitable for a Set-Cookie.
 *
 * @param payload  - state + optional PKCE verifier + platform + userId
 * @param secret   - HMAC secret (in production `env.BETTER_AUTH_SECRET`)
 */
export async function signOAuthState(
  payload: OAuthStatePayload,
  secret: string,
): Promise<string> {
  return signJwt(
    payload as unknown as Record<string, unknown>,
    secret,
    STATE_TTL_SECONDS,
  );
}

/**
 * Verify and decode a state cookie. Throws on invalid signature / expiry —
 * callers MUST catch and surface a 400 to the IdP redirect.
 */
export async function verifyOAuthState(
  token: string,
  secret: string,
): Promise<OAuthStatePayload> {
  const decoded = await verifyJwt(token, secret);
  // The payload fields land at the top of the JWT alongside `iat` / `exp`.
  const { state, codeVerifier, platform, userId } = decoded as Record<
    string,
    unknown
  >;
  if (
    typeof state !== "string" ||
    (platform !== "x" && platform !== "reddit") ||
    typeof userId !== "string"
  ) {
    throw new Error("invalid oauth state payload");
  }
  return {
    state,
    codeVerifier:
      typeof codeVerifier === "string" ? codeVerifier : undefined,
    platform,
    userId,
  };
}

/**
 * Generate a PKCE verifier + S256 challenge pair per RFC 7636.
 *
 * The verifier is 32 bytes (256 bits) base64url-encoded — comfortably
 * inside the 43–128 char window the RFC allows. The challenge is the
 * base64url of SHA-256(verifier).
 */
export async function generatePkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64UrlEncode(random);
  const challengeBytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    ),
  );
  const challenge = base64UrlEncode(challengeBytes);
  return { verifier, challenge };
}

/**
 * Generate a 128-bit random `state` nonce, base64url-encoded.
 */
export function generateState(): string {
  const random = crypto.getRandomValues(new Uint8Array(16));
  return base64UrlEncode(random);
}

function base64UrlEncode(bytes: Uint8Array): string {
  // String.fromCharCode(...) on 32-byte inputs is fine — well below the
  // call-stack arg limit. Switch to chunked encoding if we ever inline
  // larger payloads.
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
