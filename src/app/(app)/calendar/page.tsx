import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { HeaderBar } from '@/components/layout/header-bar';
import { UnifiedCalendar } from '@/components/calendar/unified-calendar';

export default async function CalendarPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  return (
    <>
      <HeaderBar title="Content Calendar" />
      <UnifiedCalendar />
    </>
  );
}
