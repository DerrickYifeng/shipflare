import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts } from '@/lib/db/schema';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:draft:handoff-confirm');

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { log } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const draft = await db.query.drafts.findFirst({
    where: eq(drafts.id, id),
  });

  if (!draft) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  if (draft.userId !== session.user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Idempotent: already-handed-off drafts return 200 without UPDATE so the
  // client can call this on every Copy / Open click without piling on writes.
  if (draft.status === 'handed_off') {
    return NextResponse.json({ success: true, alreadyHandedOff: true });
  }

  // Only pending / approved drafts can transition to handed_off here. Any
  // terminal status (posted, failed, flagged) means the user shouldn't be
  // hitting this endpoint at all — refuse with 409 so the bug is loud.
  if (draft.status !== 'pending' && draft.status !== 'approved') {
    log.warn(
      `handoff-confirm refused: draft ${id} status is ${draft.status}, expected pending|approved|handed_off`,
    );
    return NextResponse.json(
      { error: 'invalid_transition', currentStatus: draft.status },
      { status: 409 },
    );
  }

  await db
    .update(drafts)
    .set({ status: 'handed_off', updatedAt: new Date() })
    .where(eq(drafts.id, id));

  log.info(`draft ${id} handed off via clipboard page`);
  return NextResponse.json({ success: true });
}
