import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:reddit:callback');

/**
 * Legacy OAuth callback — Reddit no longer uses OAuth in handoff mode.
 * Anyone hitting this route has a stale bookmark, an in-flight redirect,
 * or is testing the deleted OAuth flow. 308-redirect to onboarding so
 * they can re-enter their handle.
 */
export async function GET(request: Request): Promise<Response> {
  log.warn(`legacy reddit OAuth callback hit: ${request.url}`);
  return NextResponse.redirect(
    new URL('/onboarding?reconnect=reddit&from=oauth_legacy', request.url),
    308,
  );
}
