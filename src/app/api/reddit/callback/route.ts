import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { encrypt } from '@/lib/encryption';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:reddit');

/**
 * Reddit OAuth callback. Exchange code for tokens, encrypt, upsert channel.
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

  // Helper: clear the state cookie on every exit path
  const clearStateCookie = (res: NextResponse) => {
    res.cookies.set('reddit_oauth_state', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    });
    return res;
  };

  // Validate CSRF state
  const storedState = request.cookies.get('reddit_oauth_state')?.value;
  if (!state || !storedState || state !== storedState) {
    log.warn('Reddit OAuth state mismatch');
    return clearStateCookie(
      NextResponse.json(
        { error: 'Invalid OAuth state' },
        { status: 400 },
      ),
    );
  }

  if (error || !code) {
    log.warn(`Reddit OAuth denied: ${error ?? 'no code'}`);
    const redirectUrl = new URL('/onboarding?reddit_error=denied', request.url);
    return clearStateCookie(NextResponse.redirect(redirectUrl));
  }

  // Exchange code for tokens
  const tokenResponse = await fetch(
    'https://www.reddit.com/api/v1/access_token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(
          `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`,
        ).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.REDDIT_REDIRECT_URI!,
      }),
    },
  );

  if (!tokenResponse.ok) {
    log.error(`Reddit token exchange failed: ${tokenResponse.status}`);
    const redirectUrl = new URL(
      '/onboarding?reddit_error=token_exchange',
      request.url,
    );
    return clearStateCookie(NextResponse.redirect(redirectUrl));
  }

  const tokens = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  // Get Reddit username
  const meResponse = await fetch('https://oauth.reddit.com/api/v1/me', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!meResponse.ok) {
    log.error(`Reddit /me failed: ${meResponse.status}`);
    const redirectUrl = new URL(
      '/onboarding?reddit_error=profile_fetch',
      request.url,
    );
    return clearStateCookie(NextResponse.redirect(redirectUrl));
  }

  const me = (await meResponse.json()) as { name: string };

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
        eq(channels.platform, 'reddit'),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(channels)
      .set({
        username: me.name,
        oauthTokenEncrypted: encryptedAccess,
        refreshTokenEncrypted: encryptedRefresh,
        tokenExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(channels.id, existing[0]!.id));
  } else {
    await db.insert(channels).values({
      userId: session.user.id,
      platform: 'reddit',
      username: me.name,
      oauthTokenEncrypted: encryptedAccess,
      refreshTokenEncrypted: encryptedRefresh,
      tokenExpiresAt: expiresAt,
    });
  }

  log.info(`Reddit account connected: u/${me.name}`);

  // Fetch recent post history for content deduplication (best-effort)
  try {
    const { RedditClient } = await import('@/lib/reddit-client');
    const channelId = existing[0]?.id ?? '';
    if (channelId) {
      const client = new RedditClient(
        channelId,
        encryptedAccess,
        encryptedRefresh,
        expiresAt,
      );
      const [userPosts, userComments] = await Promise.all([
        client.getUserPosts(me.name, 10),
        client.getUserComments(me.name, 10),
      ]);

      const postHistory = [
        ...userPosts.map((p) => ({ ...p, type: 'post' as const })),
        ...userComments.map((c) => ({ ...c, type: 'reply' as const })),
      ];

      if (postHistory.length > 0) {
        await db
          .update(channels)
          .set({ postHistory })
          .where(eq(channels.id, channelId));
        log.info(`Stored ${postHistory.length} post history items for u/${me.name}`);
      }
    }
  } catch (err) {
    log.warn(`Failed to fetch Reddit post history: ${err instanceof Error ? err.message : err}`);
  }

  return clearStateCookie(NextResponse.redirect(new URL('/today', request.url)));
}
