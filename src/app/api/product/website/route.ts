import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:product:website');

/**
 * DELETE /api/product/website
 * Clear the user's product website URL and SEO audit data.
 */
export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  log.info(`Clearing website info for user ${session.user.id}`);

  await db
    .update(products)
    .set({
      url: null,
      seoAuditJson: null,
      updatedAt: new Date(),
    })
    .where(eq(products.userId, session.user.id));

  return NextResponse.json({ success: true });
}
