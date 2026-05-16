/**
 * `GET /api/channels/reddit/connect` — kicks off Reddit OAuth 2.0.
 *
 * Reddit's OAuth doesn't require PKCE — just a state nonce. `duration=permanent`
 * is the magic param that tells Reddit to issue a refresh_token; without it
 * the access_token expires in 1h and we can't post on the founder's behalf
 * afterwards.
 *
 * Same signed-state-cookie pattern as the X flow — see `oauth-state.ts` for
 * the rationale.
 */

import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  signOAuthState,
  generateState,
  STATE_TTL_SECONDS,
} from "@/lib/oauth-state";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return new Response(null, {
      status: 302,
      headers: { Location: new URL("/", req.url).toString() },
    });
  }

  const { env } = await getCloudflareContext({ async: true });
  const publicUrl = env.BETTER_AUTH_URL ?? new URL(req.url).origin;

  const state = generateState();
  const stateToken = await signOAuthState(
    { state, platform: "reddit", userId: session.user.id },
    env.BETTER_AUTH_SECRET,
  );

  const authUrl = new URL("https://www.reddit.com/api/v1/authorize");
  authUrl.searchParams.set("client_id", env.REDDIT_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set(
    "redirect_uri",
    `${publicUrl}/api/channels/reddit/callback`,
  );
  // `permanent` is required to receive a refresh_token. `temporary` gives
  // a 1h access_token and nothing else.
  authUrl.searchParams.set("duration", "permanent");
  // Scopes:
  //   identity — /api/v1/me lookup post-auth
  //   submit   — create new posts
  //   edit     — edit own posts/comments
  //   read     — list subreddits, view threads (search)
  //   history  — list our own past submissions
  authUrl.searchParams.set("scope", "identity submit edit read history");

  const secureFlag = publicUrl.startsWith("https") ? "; Secure" : "";
  const cookie =
    `oauth-state-reddit=${stateToken}; Path=/api/channels/reddit; ` +
    `HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}${secureFlag}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      "Set-Cookie": cookie,
    },
  });
}
