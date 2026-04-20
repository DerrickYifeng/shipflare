import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

// Phase 2 stub: x_content_calendar dropped. Calendar rendering will read
// from plan_items in Phase 8/13.

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ items: [] });
}

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(
    { error: 'Endpoint retired — calendar write lands in Phase 8' },
    { status: 410 },
  );
}

export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(
    { error: 'Endpoint retired — calendar delete lands in Phase 8' },
    { status: 410 },
  );
}
