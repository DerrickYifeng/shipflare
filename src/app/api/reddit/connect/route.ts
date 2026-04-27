import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { randomBytes } from 'crypto';
import { createLogger } from '@/lib/logger';
import { readReturnToParam, setReturnToCookie } from '@/lib/oauth-return';

const log = createLogger('api:reddit');

/**
 * Initiate Reddit OAuth flow.
 * Reddit is a CONNECTED ACCOUNT, not an auth provider.
 * Scopes: identity, submit, read, history (duration=permanent).
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  log.info('Reddit OAuth flow initiated');
  const state = randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    client_id: process.env.REDDIT_CLIENT_ID!,
    response_type: 'code',
    state,
    redirect_uri: process.env.REDDIT_REDIRECT_URI!,
    duration: 'permanent',
    scope: 'identity submit read history',
  });

  const url = `https://www.reddit.com/api/v1/authorize?${params.toString()}`;

  // Store state in httpOnly cookie for CSRF validation in callback
  const response = NextResponse.redirect(url);
  response.cookies.set('reddit_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600, // 10 minutes
    path: '/',
  });

  const returnTo = readReturnToParam(request);
  if (returnTo) setReturnToCookie(response, returnTo);

  return response;
}
