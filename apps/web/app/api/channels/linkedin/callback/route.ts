/**
 * `GET /api/channels/linkedin/callback` — LinkedIn OAuth 2.0 callback.
 *
 * Differences from the X / Reddit callbacks:
 *   - No PKCE verifier (LinkedIn's OAuth 2.0 doesn't require it).
 *   - Token URL uses `application/x-www-form-urlencoded` with
 *     `client_id` + `client_secret` in the body (not Basic auth).
 *   - User endpoint is `https://api.linkedin.com/v2/me` — returns
 *     `{ id, localizedFirstName, localizedLastName, ... }` at the root.
 *     The `id` field is the canonical LinkedIn member URN suffix used
 *     by `linkedin_post` to construct `urn:li:person:<id>`.
 */

import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/db";
import { channels, eq, and } from "@shipflare/db";
import { encrypt } from "@shipflare/crypto";
import { verifyOAuthState } from "@/lib/oauth-state";

export const dynamic = "force-dynamic";

interface LinkedInTokenResponse {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expires_in?: number;
}

interface LinkedInUserResponse {
  id: string;
  localizedFirstName?: string;
  localizedLastName?: string;
}

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

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return redirectWithClearedCookie(
      `${publicUrl}/settings/channels?error=${encodeURIComponent(error)}`,
    );
  }

  if (!code || !stateParam) {
    return new Response("missing code or state", { status: 400 });
  }

  const stateCookie = readCookie(req, "oauth-state-linkedin");
  if (!stateCookie) {
    return new Response("missing state cookie", { status: 400 });
  }

  let statePayload;
  try {
    statePayload = await verifyOAuthState(stateCookie, env.BETTER_AUTH_SECRET);
  } catch {
    return new Response("invalid state cookie", { status: 400 });
  }

  if (
    statePayload.state !== stateParam ||
    statePayload.platform !== "linkedin" ||
    statePayload.userId !== session.user.id
  ) {
    return new Response("state mismatch", { status: 400 });
  }

  // LinkedIn's token endpoint expects credentials in the form body, NOT
  // HTTP Basic. The Basic-auth form returns a vague 401 with no body.
  const tokenRes = await fetch(
    "https://www.linkedin.com/oauth/v2/accessToken",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${publicUrl}/api/channels/linkedin/callback`,
        client_id: env.LINKEDIN_CLIENT_ID,
        client_secret: env.LINKEDIN_CLIENT_SECRET,
      }),
    },
  );

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    return new Response(
      `LinkedIn token exchange failed: ${errText.slice(0, 500)}`,
      { status: 500 },
    );
  }

  const tokens = (await tokenRes.json()) as LinkedInTokenResponse;

  const userRes = await fetch("https://api.linkedin.com/v2/me", {
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      // Pin the Restli protocol version — same header `linkedin_post`
      // uses on the publish path. Without it `/v2/me` returns a legacy
      // shape with `localizedHeadline` instead of `localizedFirstName`.
      "X-Restli-Protocol-Version": "2.0.0",
    },
  });
  if (!userRes.ok) {
    return new Response(
      `LinkedIn user fetch failed: ${(await userRes.text()).slice(0, 500)}`,
      { status: 500 },
    );
  }
  const userData = (await userRes.json()) as LinkedInUserResponse;

  // Compose a display username from first + last name; LinkedIn does
  // not expose the public vanity-name without an extra `r_basicprofile`
  // scope, so we fall back to the URN id when names are missing.
  const displayName =
    [userData.localizedFirstName, userData.localizedLastName]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join(" ") || userData.id;

  const accessTokenEnc = await encrypt(
    tokens.access_token,
    env.CHANNEL_ENC_KEY,
  );
  const refreshTokenEnc = tokens.refresh_token
    ? await encrypt(tokens.refresh_token, env.CHANNEL_ENC_KEY)
    : null;

  await upsertChannel({
    env,
    userId: session.user.id,
    platform: "linkedin",
    externalUserId: userData.id,
    username: displayName,
    oauthTokenEncrypted: accessTokenEnc,
    oauthRefreshEncrypted: refreshTokenEnc,
    scope: tokens.scope ?? null,
  });

  return redirectWithClearedCookie(
    `${publicUrl}/settings/channels?connected=linkedin`,
  );
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  const prefix = `${name}=`;
  return header
    .split(";")
    .map((s) => s.trim())
    .find((c) => c.startsWith(prefix))
    ?.slice(prefix.length);
}

function redirectWithClearedCookie(location: string): Response {
  const headers = new Headers();
  headers.set("Location", location);
  headers.append(
    "Set-Cookie",
    "oauth-state-linkedin=; Path=/api/channels/linkedin; HttpOnly; SameSite=Lax; Max-Age=0",
  );
  return new Response(null, { status: 302, headers });
}

interface UpsertArgs {
  env: CloudflareEnv;
  userId: string;
  platform: "linkedin";
  externalUserId: string;
  username: string | null;
  oauthTokenEncrypted: string;
  oauthRefreshEncrypted: string | null;
  scope: string | null;
}

async function upsertChannel(args: UpsertArgs): Promise<void> {
  const db = getDb(args.env);
  const now = new Date();
  const existing = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.userId, args.userId),
        eq(channels.platform, args.platform),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(channels)
      .set({
        externalUserId: args.externalUserId,
        username: args.username,
        oauthTokenEncrypted: args.oauthTokenEncrypted,
        oauthRefreshEncrypted: args.oauthRefreshEncrypted,
        scope: args.scope,
        lastVerifiedAt: now,
        status: "active",
      })
      .where(eq(channels.id, existing[0]!.id));
    return;
  }

  await db.insert(channels).values({
    id: crypto.randomUUID(),
    userId: args.userId,
    platform: args.platform,
    externalUserId: args.externalUserId,
    username: args.username,
    oauthTokenEncrypted: args.oauthTokenEncrypted,
    oauthRefreshEncrypted: args.oauthRefreshEncrypted,
    scope: args.scope,
    connectedAt: now,
    lastVerifiedAt: now,
    status: "active",
  });
}
