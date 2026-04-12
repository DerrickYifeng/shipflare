import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { randomBytes } from 'crypto';

/**
 * Initiate Reddit OAuth flow.
 * Reddit is a CONNECTED ACCOUNT, not an auth provider.
 * Scopes: identity, submit, read, history (duration=permanent).
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const state = randomBytes(16).toString('hex');
  // TODO: Store state in session/cookie for CSRF validation on callback

  const params = new URLSearchParams({
    client_id: process.env.REDDIT_CLIENT_ID!,
    response_type: 'code',
    state,
    redirect_uri: process.env.REDDIT_REDIRECT_URI!,
    duration: 'permanent',
    scope: 'identity submit read history',
  });

  const url = `https://www.reddit.com/api/v1/authorize?${params.toString()}`;
  return NextResponse.redirect(url);
}
