import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products, voiceProfiles } from '@/lib/db/schema';
import { ProductContent, type ProductSnapshot } from './product-content';

export const metadata: Metadata = { title: 'My Product' };

type Phase = ProductSnapshot['lifecyclePhase'];

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
      lifecyclePhase: products.lifecyclePhase,
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

  const initial: ProductSnapshot = {
    name: row.name,
    description: row.description,
    keywords: row.keywords,
    valueProp: row.valueProp,
    url: row.url,
    lifecyclePhase: (['pre_launch', 'launched', 'scaling'].includes(row.lifecyclePhase)
      ? row.lifecyclePhase
      : 'pre_launch') as Phase,
    updatedAt: row.updatedAt.toISOString(),
    voiceScannedAt: voice?.lastExtractedAt ? voice.lastExtractedAt.toISOString() : null,
  };

  return <ProductContent initial={initial} />;
}
