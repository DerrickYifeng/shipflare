import type { Metadata } from 'next';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { XGrowthContent } from '@/components/x-growth/x-growth-content';

export const metadata: Metadata = { title: 'Growth · X' };

export default async function XGrowthPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  return <XGrowthContent />;
}
