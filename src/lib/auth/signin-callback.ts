import type { User, Account, Profile } from 'next-auth';
import type { AdapterUser } from '@auth/core/adapters';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
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
 * Gate logic:
 *   1. If GitHub didn't return an email → redirect to /waitlist with reason=no-email
 *   2. If email is not in `allowed_emails` (or revoked) → redirect to /waitlist with the email pre-filled
 *   3. Otherwise → stamp lastLoginAt + githubId, return true
 *
 * `SUPER_ADMIN_EMAIL` is handled inside `isEmailAllowed` as the safety net.
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

  // Gate passed — stamp metadata. Best-effort: a DB blip here must NOT
  // turn a successful sign-in into AccessDenied (Auth.js wraps thrown
  // errors from this callback as access-denied).
  try {
    if (args.account?.provider === 'github' && args.profile && args.user.id) {
      const githubProfile = args.profile as { id?: number; login?: string };
      await db
        .update(users)
        .set({
          ...(githubProfile.id ? { githubId: String(githubProfile.id) } : {}),
          lastLoginAt: new Date(),
        })
        .where(eq(users.id, args.user.id));
    } else if (args.user.id) {
      await db
        .update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.id, args.user.id));
    }
  } catch (err) {
    log.error('failed to stamp signin metadata; sign-in proceeding', err);
  }

  return true;
}
