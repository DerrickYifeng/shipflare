import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products, voiceProfiles } from '@/lib/db/schema';
import { derivePhase, type ProductState } from '@/lib/launch-phase';
import { ProductContent, type ProductSnapshot } from './product-content';

export const metadata: Metadata = { title: 'My Product' };

export default async function ProductPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

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
      updatedAt: products.updatedAt,
    })
    .from(products)
    .where(eq(products.userId, session.user.id))
    .limit(1);

  if (!row) redirect('/onboarding');

  // The product profile is considered "VERIFIED" (i.e. voice scan completed)
  // when any of the user's voice profiles has a non-null `lastExtractedAt`.
  // One profile per channel; we take the most recent.
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

  const initial: ProductSnapshot = {
    name: row.name,
    description: row.description,
    keywords: row.keywords,
    valueProp: row.valueProp,
    url: row.url,
    state,
    currentPhase,
    updatedAt: row.updatedAt.toISOString(),
    voiceScannedAt: voice?.lastExtractedAt ? voice.lastExtractedAt.toISOString() : null,
  };

  return <ProductContent initial={initial} />;
}
