import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

// Phase 2 stub: the todo_items / x_content_calendar tables were dropped in
// Phase 1. The Today feed is rebuilt on top of plan_items in Phase 7/8/13.
// Until then the endpoint returns an empty feed so the UI can render.

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({
    items: [],
    stats: {
      postsQueued: 0,
      postsPublished: 0,
      repliesDrafted: 0,
      repliesSent: 0,
    },
  });
}
