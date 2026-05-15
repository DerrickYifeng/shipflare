/**
 * `GET /api/channels/reddit/callback` — Reddit OAuth 2.0 callback.
 *
 * Differences from the X callback:
 *   - No PKCE verifier (Reddit doesn't support it).
 *   - User endpoint is `https://oauth.reddit.com/api/v1/me` with a custom
 *     `User-Agent` header (Reddit returns 429 / 403 to generic UAs — they
 *     enforce the "platform:version (by /u/name)" convention from their
 *     API rules).
 *   - User response is `{ id, name, ... }` at the root (X nests under `data`).
 */

import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/db";
import { channels, eq, and } from "@shipflare/db";
import { encrypt } from "@shipflare/crypto";
import { verifyOAuthState } from "@/lib/oauth-state";

export const dynamic = "force-dynamic";

// Reddit enforces a UA convention. Including a versioned identifier helps
// when they audit suspicious traffic — keep this in sync with package
// version when we start cutting releases.
const REDDIT_USER_AGENT = "shipflare-cf/1.0";

interface RedditTokenResponse {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expires_in?: number;
}

interface RedditUserResponse {
  id: string;
  name: string;
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

  const stateCookie = readCookie(req, "oauth-state-reddit");
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
    statePayload.platform !== "reddit" ||
    statePayload.userId !== session.user.id
  ) {
    return new Response("state mismatch", { status: 400 });
  }

  const basicAuth = btoa(
    `${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`,
  );
  const tokenRes = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basicAuth}`,
      "user-agent": REDDIT_USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${publicUrl}/api/channels/reddit/callback`,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    return new Response(
      `Reddit token exchange failed: ${errText.slice(0, 500)}`,
      { status: 500 },
    );
  }

  const tokens = (await tokenRes.json()) as RedditTokenResponse;

  const userRes = await fetch("https://oauth.reddit.com/api/v1/me", {
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      "user-agent": REDDIT_USER_AGENT,
    },
  });
  if (!userRes.ok) {
    return new Response(
      `Reddit user fetch failed: ${(await userRes.text()).slice(0, 500)}`,
      { status: 500 },
    );
  }
  const userData = (await userRes.json()) as RedditUserResponse;

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
    platform: "reddit",
    externalUserId: userData.id,
    username: userData.name,
    oauthTokenEncrypted: accessTokenEnc,
    oauthRefreshEncrypted: refreshTokenEnc,
    scope: tokens.scope ?? null,
  });

  return redirectWithClearedCookie(
    `${publicUrl}/settings/channels?connected=reddit`,
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
    "oauth-state-reddit=; Path=/api/channels/reddit; HttpOnly; SameSite=Lax; Max-Age=0",
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
