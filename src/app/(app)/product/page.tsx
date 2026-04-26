import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
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
    launchDate: row.launchDate ? row.launchDate.toISOString() : null,
    launchedAt: row.launchedAt ? row.launchedAt.toISOString() : null,
    currentPhase,
    updatedAt: row.updatedAt.toISOString(),
  };

  return <ProductContent initial={initial} />;
}
