import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';

// Phase 2 stub: todo_items dropped. Replaced by plan_items lifecycle
// endpoints (`/api/plan-item/:id/approve`) in Phase 8.

export async function PATCH(
  _request: NextRequest,
  _ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(
    { error: 'Endpoint retired — plan_items lifecycle lands in Phase 8' },
    { status: 410 },
  );
}
