import type { Metadata } from 'next';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { CalendarContent } from './calendar-content';

export const metadata: Metadata = { title: 'Calendar' };
export const dynamic = 'force-dynamic';

/**
 * Calendar shell. Onboarding gate mirrors /today so users without a
 * committed product get bounced to /onboarding instead of staring at an
 * empty grid that will never populate.
 */
export default async function CalendarPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const userId = session.user.id;

  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);
  if (!product) redirect('/onboarding');

  return <CalendarContent />;
}
