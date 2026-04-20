import type { Metadata } from 'next';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { products, channels, planItems } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { TodayContent } from './today-content';

export const metadata: Metadata = { title: 'Today' };

// Today is the hot dashboard — its data changes minute to minute, so we
// never want a cached render.
export const dynamic = 'force-dynamic';

/**
 * Server-rendered shell for `/today`. Resolves the onboarding gate and
 * seeds the client with flags it would otherwise re-fetch on mount —
 * `hasChannel`, `isFirstRun`, and `onboardingCompletedAt`. The live
 * plan_items feed is fetched client-side by `use-today.ts` against
 * `/api/today`.
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

  // Parallel reads for the three server-driven flags. First-run detection
  // keys off `plan_items` presence — a committed product without any plan
  // items (which happens during the minute between commit + first plan
  // materialization, or after the planner errors out) still reads as
  // first-run so the user sees the agent-warmup state rather than an
  // empty inbox.
  const [anyChannelRow, firstPlanItem] = await Promise.all([
    db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.userId, userId))
      .limit(1),
    db
      .select({ id: planItems.id })
      .from(planItems)
      .where(eq(planItems.userId, userId))
      .limit(1),
  ]);

  const hasChannel = anyChannelRow.length > 0;
  const hasAnyPlanItems = firstPlanItem.length > 0;

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
      isFirstRun={!hasAnyPlanItems}
      hasChannel={hasChannel}
      fallbackData={fallbackData}
      yesterdayTop={null}
      lastScanAt={null}
      onboardingCompletedAt={product.onboardingCompletedAt ?? null}
    />
  );
}
