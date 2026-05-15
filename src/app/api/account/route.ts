import { NextResponse } from 'next/server';
import { auth, signOut } from '@/lib/auth';
import { db } from '@/lib/db';
import { users, sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';
import { getGitHubToken, revokeGitHubGrant } from '@/lib/github';
import { getGoogleToken, revokeGoogleGrant } from '@/lib/google';

const log = createLogger('api:account');

/**
 * DELETE /api/account
 * Delete the current user's account and all associated data.
 *
 * Order matters:
 *   1. Revoke OAuth grants FIRST, while we still have the tokens. If we
 *      delete the DB first, the plaintext tokens are gone and the provider
 *      keeps trusting the app, which shows up as "still connected" on the
 *      next sign-in click. We do this for every connected provider
 *      (GitHub, Google).
 *   2. Then cascade-delete the user. FK `onDelete: cascade` handles
 *      accounts, sessions, products, channels, threads, drafts, posts,
 *      health_scores, activity_events, and all user-owned rows.
 *
 * Revocation is best-effort: if any provider is unreachable or the token is
 * already invalid, we still delete the account. The user asked to leave; we
 * do not trap them because of an upstream API blip.
 *
 * GDPR/CCPA compliant.
 */
export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  log.info(`DELETE /api/account user=${userId}`);

  const githubToken = await getGitHubToken(userId);
  if (githubToken) {
    const revoked = await revokeGitHubGrant(githubToken);
    log.info(`GitHub grant revoke for ${userId}: ${revoked ? 'ok' : 'best-effort-failed'}`);
  }

  const googleToken = await getGoogleToken(userId);
  if (googleToken) {
    const revoked = await revokeGoogleGrant(googleToken);
    log.info(`Google grant revoke for ${userId}: ${revoked ? 'ok' : 'best-effort-failed'}`);
  }

  await db.transaction(async (tx) => {
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });

  log.info(`Account deleted: ${userId}`);

  await signOut({ redirect: false });

  return NextResponse.json({ success: true });
}
