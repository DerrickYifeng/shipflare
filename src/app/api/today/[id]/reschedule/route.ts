import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

// Reschedule flips plan_items.scheduledAt; needs a rate-limited
// endpoint that also re-validates against the current week's window
// and supersedes conflicting auto items. Deferred — surface 410 so the
// UI falls back to the error toast instead of silently "succeeding".

export async function PATCH(
  _request: Request,
  _ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(
    {
      error: 'not_supported',
      detail: 'Reschedule on plan_items is not wired yet',
    },
    { status: 410 },
  );
}
