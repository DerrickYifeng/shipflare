/**
 * `GET /api/channels/x/callback` — X OAuth 2.0 callback (PKCE).
 *
 * Steps:
 *   1. Validate the signed state cookie set by `/connect`. Reject on
 *      mismatch / missing — this is the CSRF defense.
 *   2. POST the auth code + PKCE verifier to X's token endpoint with
 *      HTTP Basic auth (confidential client).
 *   3. GET `/2/users/me` to learn the founder's X handle + numeric id.
 *   4. AES-GCM-encrypt access + refresh tokens, UPSERT into D1's
 *      `channels` table (select-then-update-or-insert because the
 *      schema has no compound unique index on (userId, platform)).
 *   5. Redirect to `/settings/channels?connected=x` and clear the
 *      state cookie.
 *
 * Tokens NEVER hit D1 in plaintext — encrypted via
 * `@shipflare/crypto.encrypt(token, env.CHANNEL_ENC_KEY)` before insert.
 */

import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/db";
import { channels, eq, and } from "@shipflare/db";
import { encrypt } from "@shipflare/crypto";
import { verifyOAuthState } from "@/lib/oauth-state";

export const dynamic = "force-dynamic";

interface XTokenResponse {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expires_in?: number;
}

interface XUserResponse {
  data: {
    id: string;
    username: string;
    name?: string;
  };
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

  // User declined consent at X — surface a friendly redirect, not a 400.
  if (error) {
    return redirectWithClearedCookie(
      `${publicUrl}/settings/channels?error=${encodeURIComponent(error)}`,
    );
  }

  if (!code || !stateParam) {
    return new Response("missing code or state", { status: 400 });
  }

  // Verify state cookie. `cookie` header parsing is intentionally manual:
  // Next.js' cookies() helper requires the App Router request context which
  // isn't reliable inside route handlers under workerd.
  const stateCookie = readCookie(req, "oauth-state-x");
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
    statePayload.platform !== "x" ||
    statePayload.userId !== session.user.id
  ) {
    return new Response("state mismatch", { status: 400 });
  }

  if (!statePayload.codeVerifier) {
    return new Response("state cookie missing PKCE verifier", { status: 400 });
  }

  // Exchange code for tokens. X requires HTTP Basic auth even for PKCE
  // clients when the app is registered as confidential (the default for
  // server-side flows).
  const basicAuth = btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`);
  const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.X_CLIENT_ID,
      redirect_uri: `${publicUrl}/api/channels/x/callback`,
      code_verifier: statePayload.codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    // Truncate — X errors can be verbose and we don't want to mirror
    // arbitrary upstream bodies to the browser.
    return new Response(
      `X token exchange failed: ${errText.slice(0, 500)}`,
      { status: 500 },
    );
  }

  const tokens = (await tokenRes.json()) as XTokenResponse;

  // Fetch X user identity (id + username) — needed for the channel row
  // and for the UI's "Connected as @handle" indicator.
  const userRes = await fetch("https://api.twitter.com/2/users/me", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) {
    return new Response(
      `X user fetch failed: ${(await userRes.text()).slice(0, 500)}`,
      { status: 500 },
    );
  }
  const userData = (await userRes.json()) as XUserResponse;

  // Encrypt tokens BEFORE the D1 write. @shipflare/crypto's `encrypt`
  // returns a base64 envelope (IV + ciphertext + GCM tag).
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
    platform: "x",
    externalUserId: userData.data.id,
    username: userData.data.username,
    oauthTokenEncrypted: accessTokenEnc,
    oauthRefreshEncrypted: refreshTokenEnc,
    scope: tokens.scope ?? null,
  });

  // Honour the `returnTo` path stashed during connect (e.g. `/onboarding`).
  // Only path-relative values are trusted (open-redirect guard: must start
  // with "/"). Fall back to `/settings/channels` if absent or invalid.
  const returnTo =
    typeof statePayload.returnTo === "string" &&
    statePayload.returnTo.startsWith("/")
      ? statePayload.returnTo
      : "/settings/channels";
  return redirectWithClearedCookie(`${publicUrl}${returnTo}`);
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
    "oauth-state-x=; Path=/api/channels/x; HttpOnly; SameSite=Lax; Max-Age=0",
  );
  return new Response(null, { status: 302, headers });
}

interface UpsertArgs {
  env: CloudflareEnv;
  userId: string;
  platform: "x" | "reddit";
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
    // Re-auth: overwrite tokens + refresh metadata. Don't bump connectedAt
    // — that's the first-ever-link timestamp.
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
