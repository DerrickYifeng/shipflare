import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products, voiceProfiles } from '@/lib/db/schema';
import { desc, eq } from 'drizzle-orm';
import { derivePhase, type ProductState } from '@/lib/launch-phase';

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
      state: products.state,
      launchDate: products.launchDate,
      launchedAt: products.launchedAt,
      targetAudience: products.targetAudience,
      category: products.category,
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

  const state = row.state as ProductState;
  const currentPhase = derivePhase({
    state,
    launchDate: row.launchDate,
    launchedAt: row.launchedAt,
  });

  return NextResponse.json({
    name: row.name,
    description: row.description,
    keywords: row.keywords,
    valueProp: row.valueProp,
    url: row.url,
    state,
    launchDate: row.launchDate ? row.launchDate.toISOString() : null,
    launchedAt: row.launchedAt ? row.launchedAt.toISOString() : null,
    targetAudience: row.targetAudience,
    category: row.category,
    currentPhase,
    updatedAt: row.updatedAt.toISOString(),
    voiceScannedAt: voice?.lastExtractedAt ? voice.lastExtractedAt.toISOString() : null,
  });
}
