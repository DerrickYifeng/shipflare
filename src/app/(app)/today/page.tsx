import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { healthScores, products, todoItems } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { HeaderBar } from '@/components/layout/header-bar';
import { TodayContent } from './today-content';

export default async function TodayPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  // Check onboarding
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.userId, session.user.id))
    .limit(1);

  if (!product) redirect('/onboarding');

  // Get latest health score
  const [latestScore] = await db
    .select()
    .from(healthScores)
    .where(eq(healthScores.userId, session.user.id))
    .orderBy(desc(healthScores.calculatedAt))
    .limit(1);

  // Check if first run (user has never had any todo items)
  const [existing] = await db
    .select({ id: todoItems.id })
    .from(todoItems)
    .where(eq(todoItems.userId, session.user.id))
    .limit(1);

  return (
    <>
      <HeaderBar title="Today" healthScore={latestScore?.score ?? null} />
      <TodayContent isFirstRun={!existing} />
    </>
  );
}
