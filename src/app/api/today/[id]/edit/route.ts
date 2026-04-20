import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

// Draft-body edits happen on the draft row, not on plan_items. The
// Today feed only surfaces plan_items in v3 so there is nothing here
// to edit yet; once drafts land on plan_items.output this shim will
// dispatch to the draft-edit endpoint.

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
      detail: 'Inline draft edit is not wired for plan_items yet',
    },
    { status: 410 },
  );
}
