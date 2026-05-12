import type { User, Account, Profile } from 'next-auth';
import type { AdapterUser } from '@auth/core/adapters';
import { isEmailAllowed, normalizeEmail } from './allowlist';
import { createLogger } from '@/lib/logger';

const log = createLogger('auth:signin');

interface SignInArgs {
  user: User | AdapterUser;
  account?: Account | null;
  profile?: Profile;
}

/**
 * NextAuth v5 signIn callback. Returns:
 *   - `true` to allow sign-in
 *   - a URL string to redirect (Auth.js v5 interprets string returns as redirects)
 *
 * Gate logic only — metadata stamping (lastLoginAt, githubId) happens in
 * the `events.signIn` event handler in `auth/index.ts` because that event
 * fires AFTER adapter.createUser() and so always has the DB UUID. Doing
 * the stamp here would silently no-op on first-time sign-ups (user.id is
 * undefined before the adapter runs).
 */
export async function signInCallback(args: SignInArgs): Promise<true | string> {
  const rawEmail = args.user.email ?? null;
  if (!rawEmail) {
    log.warn('signIn rejected: no email returned from provider');
    return '/waitlist?from=denied&reason=no-email';
  }
  const email = normalizeEmail(rawEmail);

  if (!(await isEmailAllowed(email))) {
    log.warn(`signIn rejected: ${email} not in allowlist`);
    return `/waitlist?from=denied&email=${encodeURIComponent(email)}`;
  }

  return true;
}
