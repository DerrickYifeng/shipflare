import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { encrypt } from '@/lib/encryption';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

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

  // Upsert channel
  const existing = await db
    .select()
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

  // Clear PKCE cookies and redirect
  const response = NextResponse.redirect(new URL('/today', request.url));
  response.cookies.delete('x_code_verifier');
  response.cookies.delete('x_oauth_state');
  return response;
}
