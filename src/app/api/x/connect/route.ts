import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { randomBytes, createHash } from 'crypto';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:x');

/**
 * Initiate X OAuth2 PKCE flow.
 * X requires PKCE (Proof Key for Code Exchange) unlike Reddit's standard OAuth.
 * Scopes: tweet.read, tweet.write, users.read, offline.access (for refresh token).
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const clientId = process.env.X_CLIENT_ID;
  const redirectUri = process.env.X_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return NextResponse.json(
      { error: 'X OAuth not configured' },
      { status: 500 },
    );
  }

  log.info('X OAuth flow initiated');

  // PKCE: generate code_verifier and code_challenge
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  const state = randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'tweet.read tweet.write users.read offline.access',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const url = `https://x.com/i/oauth2/authorize?${params.toString()}`;

  // Store code_verifier in httpOnly cookie (needed in callback for PKCE exchange)
  const response = NextResponse.redirect(url);
  response.cookies.set('x_code_verifier', codeVerifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600, // 10 minutes
    path: '/',
  });
  response.cookies.set('x_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });

  return response;
}
