/**
 * `/api/channels/discord/connect` — Discord bot token capture (Phase 2 lo-fi).
 *
 * Discord bots don't use end-user OAuth — they use a long-lived "Bot Token"
 * generated in the Discord Developer Portal. For Phase 2 P2-E we accept the
 * token via a server-rendered HTML form. The browser POSTs the token + a
 * default channel id; we AES-GCM-encrypt the token via @shipflare/crypto and
 * UPSERT into `channels` so `discord_post` can read it back via
 * `getChannel(env, userId, "discord")`.
 *
 * Phase 2 P2-E.2 follow-up will replace this with the real Discord OAuth
 * bot install flow (Authorize → Add to Server → Permissions grant) so the
 * founder never has to copy-paste a token.
 *
 * Why a server-side form instead of a React form: the page lives outside
 * the React app's auth-gated layout. Rendering the HTML in the route
 * handler keeps the surface small (no extra app route, no client JS) and
 * the POST handler can land the encrypted token in D1 in the same request.
 *
 * Security: this route is gated by Better Auth session AND a hidden CSRF
 * token (signed via BETTER_AUTH_SECRET) that the GET sets and the POST
 * verifies. Without the CSRF token a malicious cross-origin form could
 * trick a logged-in founder into binding an attacker's bot.
 */

import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/db";
import { channels, eq, and } from "@shipflare/db";
import { encrypt } from "@shipflare/crypto";
import { signJwt, verifyJwt } from "@/lib/jwt";

export const dynamic = "force-dynamic";

// Short-lived (10 min) signed CSRF token. Pairs the GET-rendered form
// with the POST submission. We re-use the JWT helper from oauth-state.
const CSRF_TTL_SECONDS = 600;

interface CsrfPayload {
  userId: string;
  // Random nonce so replays of an old token (within TTL) for the same
  // user still fail unless an attacker has both the cookie + payload.
  nonce: string;
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
  const nonce = crypto.randomUUID();
  const csrfToken = await signJwt(
    { userId: session.user.id, nonce } as unknown as Record<
      string,
      unknown
    >,
    env.BETTER_AUTH_SECRET,
    CSRF_TTL_SECONDS,
  );

  // Minimal CSP-friendly HTML — no inline scripts, no external assets.
  // The form posts to this same path; the POST handler verifies CSRF.
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Connect Discord Bot — ShipFlare</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p { color: #555; }
    code { background: #f4f4f5; padding: 0.1em 0.35em; border-radius: 3px; }
    label { display: block; margin-top: 1rem; font-weight: 500; }
    input { display: block; width: 100%; padding: 0.5rem 0.65rem; margin-top: 0.25rem; border: 1px solid #d4d4d8; border-radius: 4px; font: inherit; box-sizing: border-box; }
    button { margin-top: 1.25rem; padding: 0.55rem 1rem; background: #18181b; color: #fff; border: 0; border-radius: 4px; cursor: pointer; font: inherit; }
    button:hover { background: #27272a; }
    .note { background: #fef9c3; border: 1px solid #fde047; padding: 0.6rem 0.75rem; border-radius: 4px; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>Connect a Discord Bot</h1>
  <p>
    Phase 2 P2-E lo-fi: paste a bot token and default channel id. The token
    is AES-GCM encrypted before it touches the database.
  </p>
  <p class="note">
    Get your token from
    <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">discord.com/developers/applications</a>
    → your application → <strong>Bot</strong> → <strong>Reset Token</strong>.
    Invite the bot to your server, then copy any channel id (enable
    Developer Mode in Discord settings, right-click a channel, "Copy ID").
  </p>
  <form method="POST" action="/api/channels/discord/connect">
    <input type="hidden" name="csrf" value="${csrfToken}" />
    <label for="botToken">Bot Token</label>
    <input id="botToken" name="botToken" type="password" autocomplete="off" required />
    <label for="channelId">Default Channel ID</label>
    <input id="channelId" name="channelId" autocomplete="off" required />
    <button type="submit">Connect</button>
  </form>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Disable caching — every render mints a fresh CSRF token.
      "cache-control": "no-store",
    },
  });
}

export async function POST(req: Request): Promise<Response> {
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

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response("invalid form submission", { status: 400 });
  }

  const csrf = form.get("csrf");
  const botToken = form.get("botToken");
  const channelId = form.get("channelId");

  if (
    typeof csrf !== "string" ||
    typeof botToken !== "string" ||
    typeof channelId !== "string" ||
    botToken.length === 0 ||
    channelId.length === 0
  ) {
    return new Response("missing or empty form fields", { status: 400 });
  }

  // Verify the CSRF token signature + match against the current session.
  let csrfPayload: CsrfPayload;
  try {
    const decoded = (await verifyJwt(csrf, env.BETTER_AUTH_SECRET)) as Record<
      string,
      unknown
    >;
    if (
      typeof decoded["userId"] !== "string" ||
      typeof decoded["nonce"] !== "string"
    ) {
      throw new Error("invalid csrf payload shape");
    }
    csrfPayload = {
      userId: decoded["userId"],
      nonce: decoded["nonce"],
    };
  } catch {
    return new Response("invalid csrf token", { status: 400 });
  }

  if (csrfPayload.userId !== session.user.id) {
    return new Response("csrf user mismatch", { status: 400 });
  }

  // Validate the bot token + capture the bot's identity by calling
  // `/users/@me`. This both proves the token works AND gives us the
  // bot's display name + numeric id for the channel row.
  const meRes = await fetch("https://discord.com/api/v10/users/@me", {
    headers: {
      Authorization: `Bot ${botToken}`,
      "User-Agent": "shipflare-cf/1.0 (https://shipflare.com)",
    },
  });
  if (!meRes.ok) {
    const errText = await meRes.text().catch(() => "(no body)");
    return new Response(
      `Discord token verify failed (${meRes.status}): ${errText.slice(0, 500)}`,
      { status: 400 },
    );
  }
  const me = (await meRes.json()) as { id: string; username: string };

  const accessTokenEnc = await encrypt(botToken, env.CHANNEL_ENC_KEY);

  await upsertChannel({
    env,
    userId: session.user.id,
    externalUserId: me.id,
    username: me.username,
    oauthTokenEncrypted: accessTokenEnc,
    // Stash the default channel id in `scope` for now — the column is
    // free-form text and the bot-token flow doesn't have real OAuth
    // scopes. Phase 2 P2-E.2 may promote this to a dedicated column or
    // a small per-user `discord_channels` table once we support multiple
    // channels per bot.
    scope: `defaultChannel=${channelId}`,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${publicUrl}/settings/channels?connected=discord`,
    },
  });
}

interface UpsertArgs {
  env: CloudflareEnv;
  userId: string;
  externalUserId: string;
  username: string;
  oauthTokenEncrypted: string;
  scope: string;
}

async function upsertChannel(args: UpsertArgs): Promise<void> {
  const db = getDb(args.env);
  const now = new Date();
  const existing = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(eq(channels.userId, args.userId), eq(channels.platform, "discord")),
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(channels)
      .set({
        externalUserId: args.externalUserId,
        username: args.username,
        oauthTokenEncrypted: args.oauthTokenEncrypted,
        oauthRefreshEncrypted: null,
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
    platform: "discord",
    externalUserId: args.externalUserId,
    username: args.username,
    oauthTokenEncrypted: args.oauthTokenEncrypted,
    oauthRefreshEncrypted: null,
    scope: args.scope,
    connectedAt: now,
    lastVerifiedAt: now,
    status: "active",
  });
}
