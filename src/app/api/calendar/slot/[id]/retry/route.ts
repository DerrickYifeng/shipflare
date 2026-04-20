import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

// Phase 2 stub: calendar-slot-draft queue retired. plan_items draft retry
// lands with the plan-execute worker in Phase 7.

export async function POST(
  _request: Request,
  _ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(
    { error: 'Endpoint retired — plan_items retry lands in Phase 7' },
    { status: 410 },
  );
}
