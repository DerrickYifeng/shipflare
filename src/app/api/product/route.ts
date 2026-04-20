import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products, voiceProfiles } from '@/lib/db/schema';
import { desc, eq } from 'drizzle-orm';

/**
 * GET /api/product
 * Returns the authenticated user's product snapshot. Used by the v2 My Product
 * page for SWR revalidation after inline edits. Also surfaces the voice-scan
 * completion timestamp so the identity header can render the VERIFIED badge.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [row] = await db
    .select({
      name: products.name,
      description: products.description,
      keywords: products.keywords,
      valueProp: products.valueProp,
      url: products.url,
      lifecyclePhase: products.lifecyclePhase,
      updatedAt: products.updatedAt,
    })
    .from(products)
    .where(eq(products.userId, session.user.id))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const [voice] = await db
    .select({ lastExtractedAt: voiceProfiles.lastExtractedAt })
    .from(voiceProfiles)
    .where(eq(voiceProfiles.userId, session.user.id))
    .orderBy(desc(voiceProfiles.lastExtractedAt))
    .limit(1);

  return NextResponse.json({
    name: row.name,
    description: row.description,
    keywords: row.keywords,
    valueProp: row.valueProp,
    url: row.url,
    lifecyclePhase: row.lifecyclePhase,
    updatedAt: row.updatedAt.toISOString(),
    voiceScannedAt: voice?.lastExtractedAt ? voice.lastExtractedAt.toISOString() : null,
  });
}
