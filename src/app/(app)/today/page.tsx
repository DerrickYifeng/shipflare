import type { Metadata } from 'next';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { products, channels } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { TodayContent } from './today-content';

export const metadata: Metadata = { title: 'Today' };

// Today is the hot dashboard — its data changes minute to minute, so we
// never want a cached render.
export const dynamic = 'force-dynamic';

/**
 * Phase 2 stub: todo_items + x_content_calendar tables were dropped when the
 * planner refresh migration landed. The real feed is rebuilt on top of
 * plan_items in Phase 8/13. Until then this page renders TodayContent with
 * an empty fallback so the UI shell stays reachable during the migration.
 */
export default async function TodayPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const userId = session.user.id;

  // Onboarding gate — no product means the user hasn't finished setup.
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);
  if (!product) redirect('/onboarding');

  // Connected-channel gate — drives the Scan-now disabled state + FirstRun
  // branching in a single server round-trip.
  const [anyChannel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.userId, userId))
    .limit(1);

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
      isFirstRun={true}
      hasChannel={!!anyChannel}
      fallbackData={fallbackData}
      yesterdayTop={null}
      lastScanAt={null}
    />
  );
}
