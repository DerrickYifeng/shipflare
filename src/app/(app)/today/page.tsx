import type { Metadata } from 'next';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { TodayContent } from './today-content';

export const metadata: Metadata = { title: 'Today' };

// Today is the hot dashboard — its data changes minute to minute, so we
// never want a cached render.
export const dynamic = 'force-dynamic';

/**
 * Server-rendered shell for `/today`. Resolves the onboarding gate and
 * seeds the client with `onboardingCompletedAt`. The live plan_items
 * feed is fetched client-side by `use-today.ts` against `/api/today`.
 */
export default async function TodayPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const userId = session.user.id;

  // Onboarding gate — no product means the user hasn't finished setup.
  const [product] = await db
    .select({
      id: products.id,
      onboardingCompletedAt: products.onboardingCompletedAt,
    })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);
  if (!product) redirect('/onboarding');

  const fallbackData = {
    items: [],
    stats: {
      published_yesterday: 0,
      pending_count: 0,
      acted_today: 0,
    },
  };

  return (
    <TodayContent
      fallbackData={fallbackData}
      yesterdayTop={null}
      lastScanAt={null}
      onboardingCompletedAt={product.onboardingCompletedAt ?? null}
    />
  );
}
