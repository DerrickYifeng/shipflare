import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:x');

/**
 * Disconnect X account. Removes channel record.
 */
export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await db
    .delete(channels)
    .where(
      and(
        eq(channels.userId, session.user.id),
        eq(channels.platform, 'x'),
      ),
    );

  log.info(`X account disconnected for user ${session.user.id}`);
  return NextResponse.json({ success: true });
}
