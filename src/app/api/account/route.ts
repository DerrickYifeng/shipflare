import { NextResponse } from 'next/server';
import { auth, signOut } from '@/lib/auth';
import { db } from '@/lib/db';
import { users, sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:account');

/**
 * DELETE /api/account
 * Delete the current user's account and all associated data.
 * Cascade delete handles: accounts, sessions, products, channels, threads,
 * drafts, posts, health_scores, activity_events.
 * GDPR/CCPA compliant.
 */
export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  log.info(`DELETE /api/account user=${userId}`);

  // Delete in a transaction: clear sessions first, then cascade delete user
  await db.transaction(async (tx) => {
    // Explicitly delete sessions to invalidate all active sessions
    await tx.delete(sessions).where(eq(sessions.userId, userId));

    // Delete user (cascades to all related tables via FK onDelete: 'cascade')
    await tx.delete(users).where(eq(users.id, userId));
  });

  log.info(`Account deleted: ${userId}`);

  // Sign out (clear cookie)
  await signOut({ redirect: false });

  return NextResponse.json({ success: true });
}
