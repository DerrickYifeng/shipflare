/**
 * `GET /api/channels/x/connect` — kicks off X OAuth 2.0 (PKCE).
 *
 * Generates a `state` nonce + PKCE verifier/challenge, stows them in a
 * signed HttpOnly cookie (so the callback can prove the request was
 * initiated by this browser session), and redirects to X's authorize URL.
 *
 * Why a signed cookie instead of a server-side state table:
 *   - Single-source-of-truth lives in the JWT; nothing in D1 to GC.
 *   - Better Auth secret rotation invalidates in-flight OAuth too — safer
 *     than a long-lived nonce table.
 *
 * Why `new Response(null, { status: 302, headers })` instead of
 * `Response.redirect()`: workerd's `Response.redirect` returns a frozen
 * response whose headers `.append()` is a silent no-op, so the Set-Cookie
 * would be dropped and the callback would 400 on missing state.
 */

import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  signOAuthState,
  generatePkcePair,
  generateState,
  STATE_TTL_SECONDS,
} from "@/lib/oauth-state";

// Force dynamic — each call mints a fresh state + verifier. Without this
// Next.js may attempt static prerender and skip the cookie write.
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    // Unauthenticated user clicked "Connect" — bounce them to root so the
    // navigation guard can route them through sign-in.
    return new Response(null, {
      status: 302,
      headers: { Location: new URL("/", req.url).toString() },
    });
  }

  const { env } = getCloudflareContext();
  const publicUrl = env.BETTER_AUTH_URL ?? new URL(req.url).origin;

  const state = generateState();
  const { verifier, challenge } = await generatePkcePair();
  const stateToken = await signOAuthState(
    {
      state,
      codeVerifier: verifier,
      platform: "x",
      userId: session.user.id,
    },
    env.BETTER_AUTH_SECRET,
  );

  const authUrl = new URL("https://twitter.com/i/oauth2/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", env.X_CLIENT_ID);
  authUrl.searchParams.set(
    "redirect_uri",
    `${publicUrl}/api/channels/x/callback`,
  );
  // `offline.access` is required to receive a refresh_token. Without it the
  // access token expires in ~2h and we lose the ability to post on the
  // founder's behalf without re-prompting consent.
  authUrl.searchParams.set(
    "scope",
    "tweet.read tweet.write users.read offline.access",
  );
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("code_challenge", challenge);

  const secureFlag = publicUrl.startsWith("https") ? "; Secure" : "";
  // Path-scope the cookie to `/api/channels/x` so the Reddit flow's cookie
  // can't accidentally be read here (and vice versa). Both flows pass
  // through `connect` and `callback` which share the prefix.
  const cookie =
    `oauth-state-x=${stateToken}; Path=/api/channels/x; HttpOnly; ` +
    `SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}${secureFlag}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      "Set-Cookie": cookie,
    },
  });
}
