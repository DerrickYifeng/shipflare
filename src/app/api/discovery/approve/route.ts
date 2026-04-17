import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts, channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { enqueuePosting } from '@/lib/queue';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:discovery:approve');

/**
 * POST /api/discovery/approve
 * Approve or skip a discovery draft.
 */
export async function POST(request: NextRequest) {
  const { log, traceId } = loggerForRequest(baseLog, request);
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { draftId?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { draftId, action } = body;

  if (!draftId || !action || !['approve', 'skip'].includes(action)) {
    return NextResponse.json(
      { error: 'draftId and action (approve|skip) are required' },
      { status: 400 },
    );
  }

  // Verify draft belongs to user
  const [draft] = await db
    .select({ id: drafts.id, status: drafts.status })
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, session.user.id)))
    .limit(1);

  if (!draft) {
    return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  }

  if (action === 'skip') {
    await db
      .update(drafts)
      .set({ status: 'skipped' })
      .where(eq(drafts.id, draftId));

    log.info(`Draft ${draftId} skipped`);
    return NextResponse.json({ success: true, status: 'skipped' });
  }

  // Approve: update status and enqueue posting
  await db
    .update(drafts)
    .set({ status: 'approved' })
    .where(eq(drafts.id, draftId));

  // Find the user's channel for posting
  // TODO: determine platform from the thread record for multi-platform support
  const [channel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.userId, session.user.id))
    .limit(1);

  if (channel) {
    await enqueuePosting({
      userId: session.user.id,
      draftId,
      channelId: channel.id,
      traceId,
    });
    log.info(`Draft ${draftId} approved, posting enqueued`);
  } else {
    log.warn(`Draft ${draftId} approved but no channel found for posting`);
  }

  return NextResponse.json(
    { success: true, status: 'approved', traceId },
    { headers: { 'x-trace-id': traceId } },
  );
}
