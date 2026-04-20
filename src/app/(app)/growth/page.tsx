import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { GrowthContent } from './growth-content';

export const metadata: Metadata = { title: 'Growth' };

export default async function GrowthPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  return <GrowthContent />;
}
