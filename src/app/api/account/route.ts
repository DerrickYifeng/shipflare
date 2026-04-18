import { NextResponse } from 'next/server';
import { auth, signOut } from '@/lib/auth';
import { db } from '@/lib/db';
import { users, sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';
import { getGitHubToken, revokeGitHubGrant } from '@/lib/github';

const log = createLogger('api:account');

/**
 * DELETE /api/account
 * Delete the current user's account and all associated data.
 *
 * Order matters:
 *   1. Revoke the GitHub OAuth grant FIRST, while we still have the token.
 *      If we delete the DB first, the plaintext token is gone and GitHub
 *      keeps trusting the app, which shows up as "GitHub still connected"
 *      on the next sign-in click.
 *   2. Then cascade-delete the user. FK `onDelete: cascade` handles
 *      accounts, sessions, products, channels, threads, drafts, posts,
 *      health_scores, activity_events, and all user-owned rows.
 *
 * Revocation is best-effort: if GitHub is unreachable or the token is already
 * invalid, we still delete the account. The user asked to leave; we do not
 * trap them because of an upstream API blip.
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

  await db.transaction(async (tx) => {
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });

  log.info(`Account deleted: ${userId}`);

  await signOut({ redirect: false });

  return NextResponse.json({ success: true });
}
