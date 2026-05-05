/**
 * Helpers for round-tripping a "where to send the user after OAuth" target
 * through the third-party redirect dance.
 *
 * The OAuth provider's `redirect_uri` is registered server-side and can't
 * carry per-request state, so we stash the desired return path in an
 * httpOnly cookie alongside the CSRF state. The callback reads it and
 * redirects there; default fallback is `/briefing`.
 *
 * Validation prevents open-redirect: only same-origin internal paths
 * starting with a single `/` are accepted.
 */

import type { NextResponse, NextRequest } from 'next/server';

export const OAUTH_RETURN_COOKIE = 'oauth_return_to';
export const DEFAULT_OAUTH_RETURN = '/briefing';

/**
 * Accept only same-origin paths: must start with a single `/` and contain
 * no protocol-relative or backslash escape attempts.
 */
export function isSafeReturnPath(path: string | null | undefined): path is string {
  if (!path || typeof path !== 'string') return false;
  if (!path.startsWith('/')) return false;
  if (path.startsWith('//') || path.startsWith('/\\')) return false;
  return true;
}

/** Pull and validate `?returnTo=` off a connect-route request URL. */
export function readReturnToParam(req: NextRequest): string | null {
  const raw = new URL(req.url).searchParams.get('returnTo');
  return isSafeReturnPath(raw) ? raw : null;
}

/** Stamp the return path on a redirect response (or any NextResponse). */
export function setReturnToCookie(res: NextResponse, path: string): void {
  res.cookies.set(OAUTH_RETURN_COOKIE, path, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600, // matches the OAuth state cookie TTL
    path: '/',
  });
}

/**
 * Read the cookie on the callback side. Re-validates because cookies are
 * client-controlled — defense in depth even though we wrote it ourselves.
 * Returns `DEFAULT_OAUTH_RETURN` when missing or invalid.
 */
export function readReturnToCookie(req: NextRequest): string {
  const raw = req.cookies.get(OAUTH_RETURN_COOKIE)?.value;
  return isSafeReturnPath(raw) ? raw : DEFAULT_OAUTH_RETURN;
}

/** Clear the return cookie — call on every callback exit path. */
export function clearReturnToCookie(res: NextResponse): NextResponse {
  res.cookies.delete(OAUTH_RETURN_COOKIE);
  return res;
}
