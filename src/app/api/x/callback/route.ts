import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { channels, products } from '@/lib/db/schema';
import { channelPosts } from '@/lib/db/schema/channels';
import { encrypt } from '@/lib/encryption';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';
import { provisionTeamForProduct } from '@/lib/team-provisioner';

const log = createLogger('api:x');

/**
 * X OAuth2 PKCE callback. Exchange code for tokens using code_verifier, encrypt, upsert channel.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const state = searchParams.get('state');

  // Validate CSRF state
  const storedState = request.cookies.get('x_oauth_state')?.value;
  if (!state || state !== storedState) {
    log.warn('X OAuth state mismatch');
    return NextResponse.redirect(
      new URL('/onboarding?x_error=state_mismatch', request.url),
    );
  }

  if (error || !code) {
    log.warn(`X OAuth denied: ${error ?? 'no code'}`);
    return NextResponse.redirect(
      new URL('/onboarding?x_error=denied', request.url),
    );
  }

  // Retrieve PKCE code_verifier from cookie
  const codeVerifier = request.cookies.get('x_code_verifier')?.value;
  if (!codeVerifier) {
    log.error('X OAuth: missing code_verifier cookie');
    return NextResponse.redirect(
      new URL('/onboarding?x_error=pkce_missing', request.url),
    );
  }

  const clientId = process.env.X_CLIENT_ID!;
  const clientSecret = process.env.X_CLIENT_SECRET!;
  const redirectUri = process.env.X_REDIRECT_URI!;

  // Exchange code for tokens (PKCE flow)
  const tokenResponse = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text().catch(() => '');
    log.error(`X token exchange failed: ${tokenResponse.status} ${errText}`);
    return NextResponse.redirect(
      new URL('/onboarding?x_error=token_exchange', request.url),
    );
  }

  const tokens = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  // Try to get X username (requires Basic tier; Free tier returns 403)
  let username = '';
  try {
    const meResponse = await fetch('https://api.x.com/2/users/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (meResponse.ok) {
      const me = (await meResponse.json()) as {
        data: { id: string; username: string; name: string };
      };
      username = me.data.username;
    } else {
      log.warn(`X /users/me unavailable (${meResponse.status}), username will be empty`);
    }
  } catch (err) {
    log.warn(`X /users/me request failed: ${err instanceof Error ? err.message : err}`);
  }

  // Encrypt tokens
  const encryptedAccess = encrypt(tokens.access_token);
  const encryptedRefresh = encrypt(tokens.refresh_token);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  // Upsert channel — only need id to decide update vs insert
  const existing = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.userId, session.user.id),
        eq(channels.platform, 'x'),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(channels)
      .set({
        username,
        oauthTokenEncrypted: encryptedAccess,
        refreshTokenEncrypted: encryptedRefresh,
        tokenExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(channels.id, existing[0]!.id));
  } else {
    await db.insert(channels).values({
      userId: session.user.id,
      platform: 'x',
      username,
      oauthTokenEncrypted: encryptedAccess,
      refreshTokenEncrypted: encryptedRefresh,
      tokenExpiresAt: expiresAt,
    });
  }

  log.info(`X account connected: @${username}`);

  // Silently reconcile the team roster — a newly-connected X channel may
  // upgrade the preset (e.g. default-squad → dev-squad), which adds
  // community-manager. Best-effort; channel connection succeeds either way.
  try {
    const [productRow] = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.userId, session.user.id))
      .limit(1);
    if (productRow?.id) {
      const provision = await provisionTeamForProduct(
        session.user.id,
        productRow.id,
      );
      log.info(
        `provisionTeamForProduct post-x-connect: team=${provision.teamId} preset=${provision.preset}`,
      );
    }
  } catch (err) {
    log.warn(
      `provisionTeamForProduct post-x-connect failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Fetch recent post history for content deduplication (best-effort)
  try {
    const meResp = await fetch('https://api.x.com/2/users/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (meResp.ok) {
      const meData = (await meResp.json()) as { data: { id: string } };
      const xUserId = meData.data.id;

      const tweetsResp = await fetch(
        `https://api.x.com/2/users/${xUserId}/tweets?max_results=20&tweet.fields=created_at,conversation_id`,
        { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      );

      if (tweetsResp.ok) {
        const tweetsData = (await tweetsResp.json()) as {
          data?: Array<{ id: string; text: string; created_at: string; conversation_id?: string }>;
        };

        const allTweets = tweetsData.data ?? [];
        const posts = allTweets
          .filter((t) => !t.conversation_id || t.conversation_id === t.id)
          .slice(0, 10)
          .map((t) => ({ id: t.id, text: t.text, type: 'post' as const, createdAt: t.created_at }));
        const replies = allTweets
          .filter((t) => t.conversation_id && t.conversation_id !== t.id)
          .slice(0, 10)
          .map((t) => ({ id: t.id, text: t.text, type: 'reply' as const, createdAt: t.created_at }));

        const postHistory = [...posts, ...replies];
        const channelId = existing[0]?.id;

        if (channelId) {
          await db.transaction(async (tx) => {
            await tx.delete(channelPosts).where(eq(channelPosts.channelId, channelId));
            if (postHistory.length > 0) {
              await tx.insert(channelPosts).values(
                postHistory.map((p) => ({
                  channelId,
                  externalId: p.id,
                  text: p.text,
                  type: p.type,
                  postedAt: new Date(p.createdAt),
                })),
              );
            }
          });
          log.info(`Stored ${postHistory.length} post history items for @${username}`);
        }
      }
    }
  } catch (err) {
    log.warn(`Failed to fetch X post history: ${err instanceof Error ? err.message : err}`);
  }

  // Clear PKCE cookies and redirect
  const response = NextResponse.redirect(new URL('/today', request.url));
  response.cookies.delete('x_code_verifier');
  response.cookies.delete('x_oauth_state');
  return response;
}
