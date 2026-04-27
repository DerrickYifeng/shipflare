import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';

// Undo flips a terminal state back to pre-terminal. The plan-state SM
// (`src/lib/plan-state.ts`) doesn't allow that today — intentional, since
// once a post is published we can't "unpublish" it. Until the SM gets a
// dedicated unskip transition, the UI shouldn't offer undo for v3.

export async function POST(
  _request: NextRequest,
  _ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(
    {
      error: 'not_supported',
      detail: 'Undo on plan_items is not allowed by the state machine',
    },
    { status: 410 },
  );
}
