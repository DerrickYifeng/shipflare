import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

// Phase 2 stub: todo_items + x_content_calendar dropped. Rescheduling
// plan_items lands in Phase 8.

export async function PATCH(
  _request: Request,
  _ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(
    { error: 'Endpoint retired — plan_items reschedule lands in Phase 8' },
    { status: 410 },
  );
}
