import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { BriefingShell } from './_components/briefing-shell';

export default async function BriefingLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const userId = session.user.id;

  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);
  if (!product) redirect('/onboarding');

  return <BriefingShell>{children}</BriefingShell>;
}
