import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { CalendarContent } from './calendar-content';

export const metadata: Metadata = { title: 'Calendar' };

export default async function CalendarPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  return <CalendarContent />;
}
