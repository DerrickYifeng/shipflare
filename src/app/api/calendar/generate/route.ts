import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

// Phase 2 stub: calendar-planner superseded by strategic/tactical planner
// chain. Replacement endpoint is `POST /api/plan/replan` in Phase 8.

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(
    { error: 'Endpoint retired — see POST /api/plan/replan in Phase 8' },
    { status: 410 },
  );
}
