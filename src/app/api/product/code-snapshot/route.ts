import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { codeSnapshots } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:product:code-snapshot');

/**
 * DELETE /api/product/code-snapshot
 * Remove the user's code snapshot (GitHub repo scan data).
 */
export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  log.info(`Removing code snapshot for user ${session.user.id}`);

  await db
    .delete(codeSnapshots)
    .where(eq(codeSnapshots.userId, session.user.id));

  return NextResponse.json({ success: true });
}
