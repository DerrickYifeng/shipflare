import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

// Phase 2 stub: todo_items dropped. Seeding plan_items during onboarding is
// handled by the planner chain in Phase 7/8.

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ seeded: false, count: 0 });
}
