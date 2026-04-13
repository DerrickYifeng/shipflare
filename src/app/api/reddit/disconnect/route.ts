import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:reddit');

/**
 * DELETE /api/reddit/disconnect
 * Remove the user's Reddit channel connection.
 */
export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  log.info(`Disconnecting Reddit for user ${session.user.id}`);

  await db
    .delete(channels)
    .where(
      and(
        eq(channels.userId, session.user.id),
        eq(channels.platform, 'reddit'),
      ),
    );

  return NextResponse.json({ success: true });
}
