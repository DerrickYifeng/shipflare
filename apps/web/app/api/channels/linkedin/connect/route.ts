/**
 * `GET /api/channels/linkedin/connect` — kicks off LinkedIn OAuth 2.0.
 *
 * LinkedIn doesn't support PKCE, so this is simpler than the X flow:
 * just a state nonce in a signed cookie. Same signed-state-cookie
 * pattern as the X / Reddit flows — see `oauth-state.ts` for the
 * rationale (single-source-of-truth in the JWT, secret rotation
 * invalidates in-flight OAuth too).
 *
 * Scopes:
 *   r_liteprofile     — read the founder's id + name (needed for the
 *                       UGC Post `author` URN).
 *   w_member_social   — publish UGC Posts on the founder's behalf.
 *
 * Phase 2 P2-E.2 follow-up: add `r_emailaddress` so we can populate
 * the channel `username` with the founder's display name even when
 * `r_liteprofile` returns an opaque vanity-name.
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

  const { env } = getCloudflareContext();
  const publicUrl = env.BETTER_AUTH_URL ?? new URL(req.url).origin;

  const state = generateState();
  const stateToken = await signOAuthState(
    { state, platform: "linkedin", userId: session.user.id },
    env.BETTER_AUTH_SECRET,
  );

  const authUrl = new URL("https://www.linkedin.com/oauth/v2/authorization");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", env.LINKEDIN_CLIENT_ID);
  authUrl.searchParams.set(
    "redirect_uri",
    `${publicUrl}/api/channels/linkedin/callback`,
  );
  authUrl.searchParams.set("state", state);
  // Scopes: `r_liteprofile` for the member URN, `w_member_social` for
  // UGC Post publishing. LinkedIn's space-separated scope format
  // mirrors X / Reddit.
  authUrl.searchParams.set("scope", "r_liteprofile w_member_social");

  const secureFlag = publicUrl.startsWith("https") ? "; Secure" : "";
  const cookie =
    `oauth-state-linkedin=${stateToken}; Path=/api/channels/linkedin; ` +
    `HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}${secureFlag}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      "Set-Cookie": cookie,
    },
  });
}
